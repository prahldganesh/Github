/**
 * Notification worker.
 *
 * The "process the outbox" half of the pattern. It:
 *   1. claims a batch of due jobs (atomically, lease-based),
 *   2. sends each via the WhatsApp client,
 *   3. records SENT, or PENDING-with-backoff, or FAILED.
 *
 * The critical property: it is safe to kill at any instant. A crash after
 * claiming but before sending leaves the lease to expire, and another run
 * reclaims the job. A crash after sending but before recording SENT means the
 * message may be sent twice - which is unavoidable without provider-side
 * idempotency (the Cloud API has none) and is preferable to losing it. The
 * attempt counter bounds the retries either way.
 *
 * This module never throws for an expected provider failure: a WhatsApp outage
 * must leave jobs pending, not crash the worker.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { logger, errorFields } from "@/lib/logger";
import { whatsappConfigured } from "@/lib/env";
import { WhatsAppConfig } from "@/lib/whatsapp/types";
import { sendTemplateMessage } from "@/lib/whatsapp/client";
import { env } from "@/lib/env";
import { claimDueJobs, markFailed, markSent, type ClaimedJob } from "./outbox";
import { isOrderAlertPayload } from "./payload";

export type WorkerResult = {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
};

/** Exponential backoff, capped, with a little jitter to avoid thundering herds. */
export function backoffMs(attempts: number): number {
  const base = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1));
  return base + Math.floor(Math.random() * 500);
}

function whatsAppConfig(): WhatsAppConfig {
  const config = env();
  return {
    phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID ?? "",
    accessToken: config.WHATSAPP_ACCESS_TOKEN ?? "",
    graphVersion: config.META_GRAPH_VERSION,
  };
}

/**
 * Process one claimed job.
 *
 * Returns how it ended so the caller can count outcomes. Never throws: the
 * whole point is that a provider problem degrades to a retry, not a crash.
 */
async function processJob(job: ClaimedJob): Promise<"sent" | "retried" | "failed"> {
  if (job.type !== "ORDER_ALERT_BUSINESS") {
    // Only the business alert is implemented. Marking the rest FAILED (rather
    // than retrying forever) surfaces them as "not built yet" instead of as a
    // queue that never drains.
    await prisma.$transaction((tx) =>
      markFailed(tx, job.id, `No handler for notification type ${job.type}`, false, 0),
    );
    return "failed";
  }

  if (!isOrderAlertPayload(job.payload)) {
    await prisma.$transaction((tx) =>
      markFailed(tx, job.id, "Malformed payload; cannot build a message", false, 0),
    );
    return "failed";
  }

  if (!whatsappConfigured()) {
    // Not an error in the job - the environment has no WhatsApp credentials.
    // Keep it PENDING so it is sent once configured, rather than burning the
    // attempt budget on a problem credentials will fix.
    logger.warn("whatsapp not configured; leaving notification pending", { jobId: job.id });
    await prisma.$transaction((tx) =>
      markFailed(tx, job.id, "WhatsApp is not configured in this environment", true, backoffMs(1)),
    );
    return "retried";
  }

  const payload = job.payload;
  const result = await sendTemplateMessage(whatsAppConfig(), {
    to: payload.to,
    templateName: payload.templateName,
    languageCode: payload.languageCode,
    bodyParameters: payload.bodyParameters,
  });

  if (result.ok) {
    await prisma.$transaction(async (tx) => {
      await markSent(tx, job.id, result.messageId);
    });
    logger.info("notification sent", {
      jobId: job.id,
      orderId: job.orderId,
      attempts: job.attempts,
      messageId: result.messageId,
    });
    return "sent";
  }

  // The client already classified the failure. `retryable` decides whether this
  // job comes back; a permanent failure (bad token, unknown template) is
  // recorded as FAILED so a human sees it instead of an endless retry.
  const retryable = result.retryable;
  await prisma.$transaction((tx) =>
    markFailed(tx, job.id, result.message, retryable, backoffMs(job.attempts)),
  );

  logger.warn("notification attempt failed", {
    jobId: job.id,
    orderId: job.orderId,
    attempts: job.attempts,
    retryable,
    kind: result.kind,
    code: result.code,
  });

  return retryable ? "retried" : "failed";
}

/**
 * Process due notifications. Safe to run from a cron, a CLI, or on demand.
 *
 * `limit` bounds one run so a backlog cannot hold a serverless function open
 * for its whole timeout.
 */
export async function processDueNotifications(limit = 10): Promise<WorkerResult> {
  const summary: WorkerResult = { claimed: 0, sent: 0, retried: 0, failed: 0 };

  let jobs: ClaimedJob[];
  try {
    jobs = await claimDueJobs(limit);
  } catch (error) {
    logger.error("failed to claim notification jobs", errorFields(error));
    return summary;
  }

  summary.claimed = jobs.length;
  if (jobs.length === 0) return summary;

  for (const job of jobs) {
    try {
      const outcome = await processJob(job);
      summary[outcome] += 1;
    } catch (error) {
      // A bug in the handler must not lose the job: release it for a retry and
      // keep processing the rest of the batch.
      logger.error("unhandled error processing notification", {
        jobId: job.id,
        ...errorFields(error),
      });
      try {
        await prisma.$transaction((tx) =>
          markFailed(tx, job.id, "Unhandled worker error", true, backoffMs(job.attempts)),
        );
        summary.retried += 1;
      } catch (secondary) {
        logger.error("failed to record worker error", errorFields(secondary));
        summary.failed += 1;
      }
    }
  }

  logger.info("notification batch processed", { ...summary });
  return summary;
}
