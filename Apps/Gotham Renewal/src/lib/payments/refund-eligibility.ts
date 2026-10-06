/**
 * Refund eligibility - the pure rule.
 *
 * Kept in its own module, separate from `refunds.ts`, for a concrete reason:
 * `refunds.ts` imports the database and the environment, so importing it drags
 * in a Prisma client and fails under the plain-Node unit runner (which must stay
 * database-free). This rule decides whether money leaves the business, so it is
 * exactly the thing that should be provable without any infrastructure.
 *
 * It is a pure function of an order's own fields. The service re-runs it against
 * a freshly read row before acting, so the answer can never come from the form.
 */

export type RefundEligibilityPaymentMethod = "COD" | "RAZORPAY";
export type RefundEligibilityPaymentStatus = "PENDING" | "PAID" | "COD" | "FAILED" | "REFUNDED";
export type RefundEligibilityOrderStatus =
  | "NEW"
  | "CONFIRMED"
  | "PACKED"
  | "SHIPPED"
  | "DELIVERED"
  | "CANCELLED";

export type RefundableOrderShape = {
  paymentMethod: RefundEligibilityPaymentMethod;
  paymentStatus: RefundEligibilityPaymentStatus;
  orderStatus: RefundEligibilityOrderStatus;
  razorpayPaymentId: string | null;
};

export type RefundProblem =
  | { kind: "not-found" }
  | { kind: "not-paid" }
  | { kind: "not-refundable" }
  | { kind: "cod-order" }
  | { kind: "no-payment-id" }
  | { kind: "already-refunded" }
  | { kind: "already-in-progress" }
  | { kind: "provider-not-configured" }
  | { kind: "provider-error"; detail: string }
  | { kind: "uncertain"; detail: string };

/**
 * Why this order may NOT be refunded, or `null` when it may.
 *
 * Every condition is a real one:
 *  - COD has no online payment to reverse.
 *  - A payment id is required, or the provider cannot be asked.
 *  - The payment must have been captured, which locally means PAID (REFUNDED is
 *    already done; PENDING, FAILED and COD were never captured).
 *  - We refund when the order is CANCELLED while holding the customer's money.
 *    That is the CANCELLED + PAID case the dashboard surfaces. A paid order that
 *    is still being fulfilled must not be refunded by a stray click.
 */
export function refundEligibility(order: RefundableOrderShape): RefundProblem | null {
  if (order.paymentMethod === "COD") return { kind: "cod-order" };
  if (!order.razorpayPaymentId) return { kind: "no-payment-id" };
  if (order.paymentStatus === "REFUNDED") return { kind: "already-refunded" };
  if (order.paymentStatus !== "PAID") return { kind: "not-paid" };
  if (order.orderStatus !== "CANCELLED") return { kind: "not-refundable" };
  return null;
}

/**
 * The deterministic per-order idempotency key.
 *
 * Deterministic is the whole point: two concurrent refund attempts must produce
 * the same key so the database's unique constraint can reject the second. Also
 * sent to Razorpay as the refund `receipt`, which it treats as its own
 * idempotency key.
 */
export function refundIdempotencyKey(orderId: string): string {
  return `refund:${orderId}`;
}
