/**
 * Order repository - the only code that writes to the order tables.
 *
 * The service owns the *rules*; this file owns the *statements*. Keeping them
 * apart means the transaction boundary is visible in one place, and swapping
 * the data store never touches business logic.
 */
import "server-only";
import { prisma } from "@/lib/db";
import type { Order, OrderItem, Prisma } from "@/generated/prisma/client";
import type { PricedLine } from "./pricing";

/**
 * The transaction client type.
 *
 * Inside `prisma.$transaction(async (tx) => ...)` you get a `tx` that has the
 * same query surface as `prisma` but is bound to one transaction. Typing
 * helpers against it keeps them honest: a helper that must run inside the
 * transaction cannot be accidentally called with the global client, which would
 * silently escape the transaction and break atomicity.
 */
export type TxClient = Prisma.TransactionClient;

/** A product row locked for update, as the service needs it. */
export type LockableProduct = {
  id: string;
  name: string;
  slug: string;
  price: number;
  stock: number;
  active: boolean;
};

/**
 * Load products for pricing.
 *
 * A plain read: it gives the service what it needs to build a good error
 * message ("only 2 left") and to compute the money. It is NOT the concurrency
 * guard - `decrementStock` is, and it runs inside the transaction.
 */
export async function findProductsForOrder(
  tx: TxClient,
  productIds: readonly string[],
): Promise<LockableProduct[]> {
  return tx.product.findMany({
    where: { id: { in: [...productIds] } },
    select: { id: true, name: true, slug: true, price: true, stock: true, active: true },
  });
}

/**
 * Atomically reserve stock for one product.
 *
 * This single statement is the entire overselling defence. The `stock: { gte:
 * quantity }` predicate means the UPDATE only matches when there is genuinely
 * enough stock, and Postgres evaluates the read and the write of one UPDATE
 * atomically under a row lock. Two concurrent checkouts for the last unit
 * cannot both match: the second blocks, re-reads the decremented value, matches
 * zero rows, and is rejected.
 *
 * Returns true when the stock was reserved, false when it was not available.
 * Never throw here - "not enough stock" is a normal outcome, not an error.
 */
export async function decrementStock(
  tx: TxClient,
  productId: string,
  quantity: number,
): Promise<boolean> {
  const result = await tx.product.updateMany({
    where: { id: productId, active: true, stock: { gte: quantity } },
    // The version bump is what invalidates a concurrent admin's stale read.
    // Without it an admin who loaded stock 10 before this sale would later save
    // a value derived from 10 and silently erase this reservation.
    data: { stock: { decrement: quantity }, version: { increment: 1 } },
  });
  return result.count === 1;
}

/**
 * Return stock to a product (used on cancellation and the abandon sweep).
 *
 * Blind increment: an increment can never violate a constraint, so no guard is
 * needed. `active` is deliberately not required - stock returns even to a
 * product that was disabled after the order was placed.
 *
 * The version is bumped for the same reason as the decrement: stock changed, so
 * any admin edit based on an older read is now stale.
 */
export async function incrementStock(
  tx: TxClient,
  productId: string,
  quantity: number,
): Promise<void> {
  await tx.product.update({
    where: { id: productId },
    data: { stock: { increment: quantity }, version: { increment: 1 } },
  });
}

/**
 * Reserve the next order number, gap-free.
 *
 * `UPDATE ... RETURNING` takes a row lock on the counter for the duration of
 * the transaction, so two concurrent orders get different numbers. The upsert
 * covers the very first order, when no counter row exists yet.
 *
 * The lock is held until the transaction commits, which bounds order-creation
 * throughput to roughly one order per transaction duration. Correct and cheap
 * at this volume; see the `Counter` model comment for the escape hatch.
 */
export async function nextOrderNumber(tx: TxClient, counterId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ value: number }>>`
    INSERT INTO counters (id, value) VALUES (${counterId}, 1)
    ON CONFLICT (id) DO UPDATE SET value = counters.value + 1
    RETURNING value
  `;
  return rows[0].value;
}

export type CreateOrderRecord = {
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  address: string;
  city: string;
  state: string;
  pincode: string;
  subtotal: number;
  shipping: number;
  total: number;
  paymentMethod: "COD" | "RAZORPAY";
  paymentStatus: "PENDING" | "COD";
  orderStatus: "NEW";
};

export async function insertOrder(
  tx: TxClient,
  record: CreateOrderRecord,
  lines: readonly PricedLine[],
): Promise<Order> {
  return tx.order.create({
    data: {
      ...record,
      items: {
        create: lines.map((line) => ({
          productId: line.product.id,
          // The snapshot. These two values are copied, not referenced, so a
          // later rename or reprice cannot rewrite history.
          productName: line.product.name,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          total: line.total,
        })),
      },
    },
  });
}

export async function findOrderById(id: string): Promise<(Order & { items: OrderItem[] }) | null> {
  return prisma.order.findUnique({ where: { id }, include: { items: true } });
}

/**
 * Find our order from Razorpay's order id.
 *
 * This is the join key for the webhook: Razorpay's payload identifies its own
 * order (`payload.order.entity.id`), not ours, so `razorpay_order_id` is how we
 * get back to the order it belongs to. The column is unique, so this returns at
 * most one row.
 */
export async function findOrderByRazorpayOrderId(
  razorpayOrderId: string,
): Promise<(Order & { items: OrderItem[] }) | null> {
  return prisma.order.findUnique({
    where: { razorpayOrderId },
    include: { items: true },
  });
}

/**
 * Attach Razorpay's order id to our order.
 *
 * Runs AFTER the provider call, outside the order-creation transaction, because
 * an external HTTP call must never be held open inside a transaction.
 */
export async function attachRazorpayOrderId(
  orderId: string,
  razorpayOrderId: string,
): Promise<Order> {
  return prisma.order.update({
    where: { id: orderId },
    data: { razorpayOrderId },
  });
}

/**
 * Mark an order paid. Narrow on purpose: money-affecting fields only, so a bug
 * in the webhook path cannot rewrite the customer's address or the totals.
 */
export async function markOrderPaid(
  tx: TxClient,
  orderId: string,
  razorpayPaymentId: string | null,
): Promise<Order> {
  return tx.order.update({
    where: { id: orderId },
    data: {
      paymentStatus: "PAID",
      razorpayPaymentId: razorpayPaymentId ?? undefined,
      // A paid order the shop has not yet acted on is NEW; leave the fulfilment
      // status alone so an admin's progress is not reset by a late webhook.
    },
  });
}

export async function findOrderByNumber(
  orderNumber: string,
): Promise<(Order & { items: OrderItem[] }) | null> {
  return prisma.order.findUnique({ where: { orderNumber }, include: { items: true } });
}

/** Recent orders for the admin dashboard (Phase 8). */
export async function listOrders(limit = 100): Promise<Order[]> {
  return prisma.order.findMany({ orderBy: { createdAt: "desc" }, take: limit });
}

/**
 * Online orders that were never paid and are old enough to give up on.
 *
 * Only RAZORPAY orders qualify. A COD order is never "awaiting payment" - its
 * money is collected on delivery - so sweeping one would cancel real orders.
 *
 * `paymentStatus: PENDING` is the defining condition: once a webhook has marked
 * an order PAID (or FAILED), it is no longer awaiting anything.
 */
export async function findStaleUnpaidOrders(
  olderThan: Date,
  limit = 50,
): Promise<Array<{ id: string; orderNumber: string }>> {
  return prisma.order.findMany({
    where: {
      paymentMethod: "RAZORPAY",
      paymentStatus: "PENDING",
      orderStatus: { in: ["NEW", "CONFIRMED"] },
      createdAt: { lt: olderThan },
    },
    select: { id: true, orderNumber: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}

/**
 * Abandon an unpaid order, but ONLY if it is still unpaid and uncancelled.
 *
 * This is a guarded update, the same shape as the stock decrement, and it is
 * the whole reason the sweep is safe. A webhook can mark the order PAID at the
 * same instant the sweep runs; Postgres serialises the two updates on the row,
 * so whichever commits first wins and the second matches zero rows.
 *
 * Returns the number of rows changed: 1 means we cancelled it, 0 means someone
 * else got there first (a payment arrived, or a human acted) and we must do
 * nothing - critically, we must NOT restock a paid order.
 */
export async function abandonUnpaidOrder(
  tx: TxClient,
  orderId: string,
): Promise<number> {
  const result = await tx.order.updateMany({
    where: {
      id: orderId,
      paymentStatus: "PENDING",
      orderStatus: { in: ["NEW", "CONFIRMED"] },
    },
    data: {
      orderStatus: "CANCELLED",
      paymentStatus: "FAILED",
    },
  });
  return result.count;
}

/**
 * Update an order's status.
 *
 * Deliberately narrow: it takes only the status, so a bug or a forged request
 * cannot accidentally overwrite money or customer details through the same
 * path. The legality of the transition is checked by the service before this is
 * called.
 */
export async function updateOrderStatus(
  orderId: string,
  status: Order["orderStatus"],
): Promise<Order> {
  return prisma.order.update({ where: { id: orderId }, data: { orderStatus: status } });
}

/** Counts for the admin dashboard summary. */
export type OrderCounts = {
  total: number;
  byStatus: Array<{ status: Order["orderStatus"]; count: number }>;
  byPaymentStatus: Array<{ status: Order["paymentStatus"]; count: number }>;
  revenuePaiseIfDelivered: number;
};

export async function countOrders(): Promise<OrderCounts> {
  const [total, byStatus, byPaymentStatus, delivered] = await Promise.all([
    prisma.order.count(),
    prisma.order.groupBy({ by: ["orderStatus"], _count: { _all: true } }),
    prisma.order.groupBy({ by: ["paymentStatus"], _count: { _all: true } }),
    // Revenue counts only delivered orders: an order that was never delivered
    // was never paid for, so counting it would overstate the business.
    prisma.order.aggregate({
      where: { orderStatus: "DELIVERED" },
      _sum: { total: true },
    }),
  ]);

  return {
    total,
    byStatus: byStatus.map((row) => ({ status: row.orderStatus, count: row._count._all })),
    byPaymentStatus: byPaymentStatus.map((row) => ({
      status: row.paymentStatus,
      count: row._count._all,
    })),
    revenuePaiseIfDelivered: delivered._sum.total ?? 0,
  };
}

/**
 * Orders that were paid AFTER being cancelled.
 *
 * This is the late-capture state: the sweep abandoned an unpaid order, and then
 * the customer's payment landed. The order is `CANCELLED` with `PAID` money -
 * truthful, but the shop owes a refund and nobody has been told. It is exactly
 * the kind of state that must be surfaced rather than buried, so the admin
 * dashboard shows it prominently and the orders list can be filtered to it.
 *
 * Distinct from an ordinary cancellation, where the payment status stays
 * `PENDING` (online, never paid) or `COD`.
 */
export async function findPaidButCancelledOrders(limit = 100): Promise<Order[]> {
  return prisma.order.findMany({
    where: { orderStatus: "CANCELLED", paymentStatus: "PAID" },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function countPaidButCancelledOrders(): Promise<number> {
  return prisma.order.count({
    where: { orderStatus: "CANCELLED", paymentStatus: "PAID" },
  });
}

/**
 * Customers, derived from their orders.
 *
 * There is no customer table, and that is deliberate: a customer places an order
 * and gives their details at that moment. The phone number is the natural key
 * (validation normalises it to the last 10 digits, so `+91…` and `0…` variants
 * of one number collapse together).
 *
 * WHY RAW SQL rather than `groupBy`. Prisma's `groupBy` can return the
 * aggregates - count, sum, min, max - but not the customer's *name*, because
 * name is not grouped. Fetching it would mean a second query per customer
 * (an N+1). Postgres can do it in one pass with `array_agg(... ORDER BY
 * created_at DESC)[1]`, which picks the name from their most recent order. That
 * also means a customer who gave a fuller name later is shown by that name.
 *
 * The value excludes cancelled orders: a cancelled order is not revenue, and
 * counting it would make a customer look more valuable than they are. The order
 * count still includes them, so a cancelled order is visible in the history
 * rather than hidden.
 */
export type CustomerSummary = {
  phone: string;
  name: string;
  email: string | null;
  orderCount: number;
  valuePaise: number;
  firstOrderAt: Date;
  lastOrderAt: Date;
};

export async function listCustomers(limit = 100): Promise<CustomerSummary[]> {
  return prisma.$queryRaw<CustomerSummary[]>`
    SELECT
      customer_phone AS "phone",
      (array_agg(customer_name ORDER BY created_at DESC))[1] AS "name",
      (array_agg(customer_email ORDER BY created_at DESC))[1] AS "email",
      count(*)::int AS "orderCount",
      coalesce(sum(total) FILTER (WHERE order_status <> 'CANCELLED'), 0)::int AS "valuePaise",
      min(created_at) AS "firstOrderAt",
      max(created_at) AS "lastOrderAt"
    FROM orders
    GROUP BY customer_phone
    ORDER BY max(created_at) DESC
    LIMIT ${limit}::int
  `;
}

/** Every order placed by one phone number, newest first. */
export async function listOrdersForCustomer(phone: string): Promise<Order[]> {
  return prisma.order.findMany({
    where: { customerPhone: phone },
    orderBy: { createdAt: "desc" },
  });
}
