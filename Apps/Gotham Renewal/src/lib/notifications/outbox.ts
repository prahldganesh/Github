/**
 * Notification outbox repository.
 *
 * The durable job queue. Its design goal is that a notification cannot be lost:
 * every state transition is a committed write, and a worker that dies mid-send
 * leaves the job in a state another worker can recover.
 *
 * The three operations that matter:
 *
 *   enqueue        - insert the job INSIDE the business transaction
 *   claim          - atomically lease due jobs, skipping ones already leased
 *   complete/fail  - record the outcome, scheduling a retry when appropriate
 *
 * The claim is the subtle one. It uses `FOR UPDATE SKIP LOCKED`, which lets
 * several workers run concurrently without ever handing the same job to two of
 * them: a row another transaction has locked is skipped rather than waited for.
 */
import "server-only";
import { prisma } from "@/lib/db";
import type { Notification, NotificationType, Prisma } from "@/generated/prisma/client";
import type { TxClient } from "@/lib/orders/repository";

/** How long a worker may hold a job before another may reclaim it. */
export const LEASE_MS = 60_000;

/** Give up after this many attempts and mark the job FAILED for a human. */
export const MAX_ATTEMPTS = 5;

export type EnqueueInput = {
  orderId: string;
  type: NotificationType;
  recipient: string;
  payload: Prisma.InputJsonValue;
};

/**
 * Insert a notification job.
 *
 * MUST be called with the transaction client from the order transaction, so the
 * order and its notification obligation commit together. Taking a plain
 * `PrismaClient` here would silently write outside the transaction and
 * reintroduce the window this pattern exists to close.
 */
export async function enqueueNotification(
  tx: TxClient,
  input: EnqueueInput,
): Promise<Notification> {
  return tx.notification.create({
    data: {
      orderId: input.orderId,
      type: input.type,
      recipient: input.recipient,
      payload: input.payload,
      status: "PENDING",
      nextAttemptAt: new Date(),
    },
  });
}

export type ClaimedJob = {
  id: string;
  orderId: string;
  type: NotificationType;
  recipient: string;
  payload: unknown;
  attempts: number;
};

/**
 * Atomically lease up to `limit` due jobs for this worker.
 *
 * Runs as one statement:
 *
 *   SELECT ... FOR UPDATE SKIP LOCKED   (find work nobody else holds)
 *   UPDATE ... SET locked_at = now()    (hold it)
 *
 * `SKIP LOCKED` is what makes concurrent workers safe. Without it, two workers
 * would both read the same PENDING row and both send the message.
 *
 * TIMESTAMP-ARITHMETIC NOTE. Every timestamp is computed by Postgres, and only
 * integers cross the boundary. Passing a JS `Date` as a `::timestamptz`
 * parameter is a trap: the driver serializes it to a naive local-time string,
 * which Postgres then reinterprets in the session timezone. With a +05:30
 * session that turns "60 seconds in the future" into "5.5 hours in the past",
 * the lease looks instantly expired, and a second worker claims the same job -
 * sending the customer two messages. Integers cannot drift like that.
 *
 * `next_attempt_at <= now()` means a job scheduled for a backoff retry is not
 * picked up early. The lease check means a job whose worker died is reclaimed
 * once `LEASE_MS` has passed.
 */
export async function claimDueJobs(limit = 10): Promise<ClaimedJob[]> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<ClaimedJob[]>`
      WITH due AS (
        SELECT id FROM notifications
        WHERE status = 'PENDING'
          AND next_attempt_at <= now()
          AND (
            locked_at IS NULL
            OR locked_at < now() - (${LEASE_MS}::int * interval '1 millisecond')
          )
        ORDER BY next_attempt_at ASC
        LIMIT ${limit}::int
        FOR UPDATE SKIP LOCKED
      )
      UPDATE notifications n
      SET locked_at = now() + (${LEASE_MS}::int * interval '1 millisecond'),
          attempts = n.attempts + 1,
          updated_at = now()
      FROM due
      WHERE n.id = due.id
      RETURNING n.id, n.order_id AS "orderId", n.type, n.recipient, n.payload, n.attempts
    `;
    return rows;
  });
}

/** Mark a job sent, recording the provider's id. */
export async function markSent(
  tx: TxClient,
  jobId: string,
  providerMessageId: string | null,
): Promise<void> {
  await tx.notification.update({
    where: { id: jobId },
    data: {
      status: "SENT",
      sentAt: new Date(),
      lockedAt: null,
      providerMessageId,
      lastError: null,
    },
  });
}

/**
 * Record a failed attempt.
 *
 * A retryable failure keeps the job PENDING with a future `nextAttemptAt`, so
 * the worker picks it up again after the backoff. A permanent failure - or
 * exhausting the attempt budget - marks it FAILED, which means "a human must
 * look at this". Either way the job is released (`lockedAt: null`) so it is not
 * stuck behind a dead worker's lease.
 */
export async function markFailed(
  tx: TxClient,
  jobId: string,
  error: string,
  retryable: boolean,
  backoffMs: number,
): Promise<void> {
  const existing = await tx.notification.findUnique({ where: { id: jobId } });
  const attempts = existing?.attempts ?? MAX_ATTEMPTS;
  const giveUp = !retryable || attempts >= MAX_ATTEMPTS;

  await tx.notification.update({
    where: { id: jobId },
    data: {
      status: giveUp ? "FAILED" : "PENDING",
      lockedAt: null,
      lastError: error.slice(0, 2000),
      nextAttemptAt: giveUp ? new Date() : new Date(Date.now() + backoffMs),
    },
  });
}

/** Fetch a job by id. For the CLI and tests. */
export async function findNotification(id: string): Promise<Notification | null> {
  return prisma.notification.findUnique({ where: { id } });
}

/** All notifications for an order. */
export async function listNotificationsForOrder(orderId: string): Promise<Notification[]> {
  return prisma.notification.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
}

/** Counts by status, for the admin dashboard. */
export async function countNotificationsByStatus(): Promise<Record<string, number>> {
  const rows = await prisma.notification.groupBy({ by: ["status"], _count: { _all: true } });
  return Object.fromEntries(rows.map((row) => [row.status, row._count._all]));
}
