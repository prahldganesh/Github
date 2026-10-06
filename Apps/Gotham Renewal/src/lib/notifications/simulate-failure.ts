/**
 * Test support for the notification outbox.
 *
 * Lives in `src/` rather than `scripts/` so the durability check and any future
 * test can both use it, and so it is type-checked with the rest of the app.
 *
 * It deliberately contains the *decision* logic for a failed attempt (retry or
 * give up?) so the check exercises the real `markFailed` path rather than a
 * re-implementation of it.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { markFailed } from "./outbox";
import type { Notification } from "@/generated/prisma/client";

/**
 * Record a provider failure on a job, exactly as the worker would.
 *
 * `retryable` mirrors the classification the WhatsApp client returns: a timeout
 * or a 5xx is retryable, an invalid token or an unknown template is not.
 *
 * This exists so the durability check can simulate an outage without WhatsApp
 * credentials and without a network call.
 */
export async function maskProviderFailure(
  jobId: string,
  retryable: boolean,
  backoffMs: number,
  message = "simulated provider outage",
): Promise<Notification> {
  await prisma.$transaction((tx) => markFailed(tx, jobId, message, retryable, backoffMs));
  const updated = await prisma.notification.findUnique({ where: { id: jobId } });
  if (!updated) throw new Error(`notification ${jobId} disappeared`);
  return updated;
}
