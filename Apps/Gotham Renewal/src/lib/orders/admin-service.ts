/**
 * Admin order service.
 *
 * The rules for an administrator changing an order: verify the transition is
 * legal, and if it is a cancellation, return the reserved stock - both in one
 * transaction so they cannot half-happen.
 *
 * Stock return lives here rather than in the repository because it is a
 * *business* consequence of cancelling (ADR-0003), not a storage detail.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { logger, errorFields } from "@/lib/logger";
import { findOrderById, incrementStock } from "./repository";
import { canTransition, shouldRestock, transitionRefusal } from "./status";
import type { OrderStatus } from "@/generated/prisma/enums";

export type UpdateStatusResult =
  | { ok: true; status: OrderStatus }
  | { ok: false; message: string };

/**
 * Move an order to a new status.
 *
 * Everything happens inside one transaction: the status update and, when
 * cancelling, the stock increments. If any increment fails, the status change
 * rolls back too - so an order is never left CANCELLED with its stock still
 * reserved (which would silently shrink the shop's sellable inventory).
 */
export async function updateOrderStatus(
  orderId: string,
  nextStatus: OrderStatus,
): Promise<UpdateStatusResult> {
  const order = await findOrderById(orderId);
  if (!order) return { ok: false, message: "Order not found." };

  const current = order.orderStatus;
  if (!canTransition(current, nextStatus)) {
    return { ok: false, message: transitionRefusal(current, nextStatus) };
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { orderStatus: nextStatus },
      });

      if (shouldRestock(nextStatus)) {
        for (const item of order.items) {
          // productId is nullable (the product may have been removed from the
          // catalogue). There is nothing to restock if it is gone.
          if (!item.productId) continue;
          await incrementStock(tx, item.productId, item.quantity);
        }
      }
    });

    logger.info("order status changed", {
      orderId,
      orderNumber: order.orderNumber,
      from: current,
      to: nextStatus,
      restocked: shouldRestock(nextStatus),
    });

    return { ok: true, status: nextStatus };
  } catch (error) {
    logger.error("failed to change order status", errorFields(error));
    return { ok: false, message: "Could not update the order. Please try again." };
  }
}
