/**
 * Payment event idempotency.
 *
 * The rule: a webhook is accepted into `payment_events` by INSERT, and the
 * DATABASE's unique constraint on (provider, providerEventId) decides who wins.
 * The application does not "check then insert" - that has a race between the
 * check and the insert during which two deliveries both see "not processed" and
 * both apply the payment twice.
 *
 * WHY `INSERT ... ON CONFLICT DO NOTHING RETURNING`, not catch-P2002.
 * In Postgres, a constraint violation ABORTS the current transaction: every
 * statement after it fails with "current transaction is aborted, commands
 * ignored until end of transaction block". So the naive
 *
 *     try { insert } catch { read existing }
 *
 * cannot work inside the transaction that must also update the order - the
 * `catch` runs in a poisoned transaction and the order update that follows it
 * fails too. `ON CONFLICT DO NOTHING` never raises: it returns one row when the
 * insert happened, zero rows when it was a duplicate, and leaves the
 * transaction perfectly usable either way.
 *
 * So the signal is the ROW COUNT, not an exception.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { TxClient } from "@/lib/orders/repository";
import type { PaymentEvent, Prisma } from "@/generated/prisma/client";

export type RecordEventResult =
  | { outcome: "new"; event: PaymentEvent }
  | { outcome: "duplicate"; event: PaymentEvent };

/**
 * Record a payment event, or report that it was already recorded.
 *
 * MUST run inside the same transaction as the order update it authorises, so
 * "we processed this event" and "the order now reflects it" commit together. If
 * the order update failed and the event row survived, a retry would be treated
 * as a duplicate and the payment would never be applied - the order would be
 * stuck unpaid forever. Check B in `scripts/check-webhook-idempotency.ts` tests
 * exactly that.
 *
 * Returns a typed result rather than throwing, because a duplicate is expected:
 * providers retry, and the same delivery arriving twice is the normal case this
 * function exists to handle.
 */
export async function recordPaymentEvent(
  tx: TxClient,
  input: {
    orderId: string;
    provider: string;
    providerEventId: string;
    eventType: string;
    payload: Prisma.InputJsonValue;
  },
): Promise<RecordEventResult> {
  // `RETURNING id` yields a row only when the INSERT actually happened.
  const inserted = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO payment_events (order_id, provider, provider_event_id, event_type, payload)
    VALUES (
      ${input.orderId}::uuid,
      ${input.provider},
      ${input.providerEventId},
      ${input.eventType},
      ${JSON.stringify(input.payload)}::jsonb
    )
    ON CONFLICT (provider, provider_event_id) DO NOTHING
    RETURNING id
  `;

  if (inserted.length === 1) {
    const event = await tx.paymentEvent.findUniqueOrThrow({ where: { id: inserted[0].id } });
    return { outcome: "new", event };
  }

  // Zero rows means the unique constraint matched: this delivery was already
  // processed. A concurrent winner may not have committed yet, so the row is
  // read with the same transaction's snapshot - which is correct, because we
  // only need to know that this event is not ours to apply.
  const existing = await tx.paymentEvent.findUnique({
    where: {
      provider_providerEventId: {
        provider: input.provider,
        providerEventId: input.providerEventId,
      },
    },
  });

  if (!existing) {
    // Genuinely unexpected: the conflict fired but no row is visible. Failing
    // loudly is right - silently treating it as handled could drop a payment.
    throw new Error(
      `Conflict on ${input.provider}/${input.providerEventId} but no existing row is visible`,
    );
  }

  logger.info("duplicate payment event ignored", {
    provider: input.provider,
    providerEventId: input.providerEventId,
    orderId: input.orderId,
  });

  return { outcome: "duplicate", event: existing };
}

/** Has this event already been processed? For read-only diagnostics. */
export async function findPaymentEvent(
  provider: string,
  providerEventId: string,
): Promise<PaymentEvent | null> {
  return prisma.paymentEvent.findUnique({
    where: { provider_providerEventId: { provider, providerEventId } },
  });
}

/** All events for an order, oldest first. */
export async function listPaymentEventsForOrder(orderId: string): Promise<PaymentEvent[]> {
  return prisma.paymentEvent.findMany({ where: { orderId }, orderBy: { processedAt: "asc" } });
}
