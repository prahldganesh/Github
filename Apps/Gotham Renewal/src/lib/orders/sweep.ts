/**
 * Abandoned-order sweep.
 *
 * Online orders whose payment never arrived hold their stock forever, because
 * stock is reserved at creation (ADR-0003). A customer who opens Razorpay,
 * changes their mind, and closes the tab has still reserved a unit. Left alone,
 * the shop slowly sells out of things it actually has.
 *
 * This cancels those orders and returns their stock.
 *
 * THE HARD PART is the race. A webhook can capture a payment at the same moment
 * the sweep runs. Two outcomes are unacceptable:
 *
 *   1. Cancelling an order that was just paid (and restocking it) - the customer
 *      paid and we have both given away their stock and not shipped their order.
 *   2. Restocking an order twice, inventing inventory.
 *
 * Both are prevented by the guarded update in `abandonUnpaidOrder`: it only
 * matches an order that is still `PENDING` and still `NEW`/`CONFIRMED`, so
 * whichever of the webhook and the sweep commits first wins outright. The
 * loser's update matches zero rows and it does nothing. Restock runs inside the
 * same transaction as the cancel, so they cannot half-happen.
 *
 * A LATE CAPTURE IS STILL POSSIBLE and is handled honestly rather than hidden:
 * if the money arrives after abandonment, the webhook's decision logic marks
 * paymentStatus PAID on the now-CANCELLED order, and enqueues the owner's alert.
 * "Cancelled but paid" is a truthful state that a human must refund. Silently
 * ignoring that money would be theft.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { logger, errorFields } from "@/lib/logger";
import {
  abandonUnpaidOrder,
  findStaleUnpaidOrders,
  findOrderById,
  incrementStock,
} from "./repository";

/**
 * How long an unpaid online order is given before it is abandoned.
 *
 * Long enough for a genuine customer to finish paying (including a UPI retry),
 * short enough that stock is not held hostage for a day. Razorpay's own payment
 * attempts expire well within this.
 */
export const STALE_PENDING_MINUTES = 60;

export type SweepResult = {
  examined: number;
  cancelled: number;
  skipped: number;
  failed: number;
};

/**
 * Cancel unpaid orders older than the threshold, returning their stock.
 *
 * Each order is handled in its own transaction, so one bad order cannot abort
 * the batch and leave the rest unswept.
 */
export async function sweepStalePendingOrders(
  olderThanMinutes = STALE_PENDING_MINUTES,
  limit = 50,
): Promise<SweepResult> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const summary: SweepResult = { examined: 0, cancelled: 0, skipped: 0, failed: 0 };

  let stale: Array<{ id: string; orderNumber: string }>;
  try {
    stale = await findStaleUnpaidOrders(cutoff, limit);
  } catch (error) {
    logger.error("failed to find stale unpaid orders", errorFields(error));
    return summary;
  }

  summary.examined = stale.length;

  for (const candidate of stale) {
    try {
      const outcome = await prisma.$transaction(async (tx) => {
        // Guarded: only cancels if the order is STILL unpaid. If a payment
        // arrived since the query above, this matches nothing.
        const cancelled = await abandonUnpaidOrder(tx, candidate.id);
        if (cancelled === 0) return "skipped" as const;

        // Restock only after winning the guard, so a paid order is never
        // restocked.
        const order = await tx.order.findUnique({
          where: { id: candidate.id },
          include: { items: true },
        });
        if (order) {
          for (const item of order.items) {
            if (!item.productId) continue;
            await incrementStock(tx, item.productId, item.quantity);
          }
        }
        return "cancelled" as const;
      });

      if (outcome === "cancelled") {
        summary.cancelled += 1;
        logger.info("abandoned unpaid order cancelled and restocked", {
          orderId: candidate.id,
          orderNumber: candidate.orderNumber,
          olderThanMinutes,
        });
      } else {
        summary.skipped += 1;
        // Not an error: a payment landed between the query and the update.
        logger.info("stale order was settled before it could be abandoned", {
          orderId: candidate.id,
          orderNumber: candidate.orderNumber,
        });
      }
    } catch (error) {
      summary.failed += 1;
      logger.error("failed to abandon a stale order", {
        orderId: candidate.id,
        orderNumber: candidate.orderNumber,
        ...errorFields(error),
      });
    }
  }

  return summary;
}

/** Admin-facing: how many orders would the sweep cancel right now? */
export async function countStalePendingOrders(
  olderThanMinutes = STALE_PENDING_MINUTES,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  return (await findStaleUnpaidOrders(cutoff, 200)).length;
}

export { findOrderById };
