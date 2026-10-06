/**
 * What a payment webhook MEANS for an order.
 *
 * A pure function: given the current payment status and an event, decide what
 * should happen. No database, no HTTP, so the rules are testable directly and
 * the webhook route stays transport.
 *
 * The rules exist because webhook events are not a clean sequence:
 *
 *   - Providers redeliver. The same `payment.captured` can arrive twice; the
 *     second must mean "nothing to do", not "mark paid again".
 *   - Events arrive out of order. A `payment.authorized` may overtake
 *     `payment.captured`.
 *   - `payment.failed` is NOT terminal. A UPI retry can produce a later
 *     `payment.captured` for the same payment, so a failure must not lock the
 *     order out of ever being paid.
 *   - An already-PAID order must never be downgraded by a stale failure event.
 */
import type { PaymentStatus } from "@/generated/prisma/enums";

export type PaymentEventType =
  | "payment.captured"
  | "payment.authorized"
  | "order.paid"
  | "payment.failed"
  | "refund.processed"
  | string;

export type PaymentDecision =
  /** Apply the event: mark the order paid and record the payment id. */
  | { action: "mark-paid"; reason: string }
  /** Record the event for audit, change nothing. */
  | { action: "ignore"; reason: string }
  /** Refund observed: the money went back. */
  | { action: "mark-refunded"; reason: string }
  /** Failure observed, but it may be superseded by a later capture. */
  | { action: "mark-failed"; reason: string };

/** Event types that mean the money has definitely arrived. */
const CAPTURE_EVENTS = new Set(["payment.captured", "order.paid"]);

export function decidePaymentAction(
  currentStatus: PaymentStatus,
  eventType: PaymentEventType,
): PaymentDecision {
  // Already settled: nothing any event can do, including a stale failure.
  // Returning "ignore" (rather than an error) is what keeps a redelivered
  // capture idempotent at the decision layer as well as at the event layer.
  if (currentStatus === "PAID" && CAPTURE_EVENTS.has(eventType)) {
    return { action: "ignore", reason: "order is already paid" };
  }

  if (eventType === "refund.processed") {
    if (currentStatus === "REFUNDED") {
      return { action: "ignore", reason: "order is already refunded" };
    }
    return { action: "mark-refunded", reason: "refund received" };
  }

  if (CAPTURE_EVENTS.has(eventType)) {
    return { action: "mark-paid", reason: `capture event ${eventType}` };
  }

  if (eventType === "payment.failed") {
    // Never downgrade a paid order, and never make a failure terminal in a way
    // that blocks a later capture. FAILED records the fact; PENDING is the
    // honest status for "awaiting a retry that may still succeed".
    if (currentStatus === "PAID") {
      return { action: "ignore", reason: "a failure event cannot undo a paid order" };
    }
    if (currentStatus === "REFUNDED") {
      return { action: "ignore", reason: "order is refunded" };
    }
    return { action: "mark-failed", reason: "payment failed; a retry may still capture" };
  }

  // payment.authorized, payment.created, and anything we do not model. The
  // money has not arrived, so the order stays as it is - but the event is still
  // recorded in payment_events, so it is auditable.
  return { action: "ignore", reason: `no order change for ${eventType}` };
}

/** Whether this event should trigger the owner's alert again. */
export function shouldNotify(decision: PaymentDecision): boolean {
  return decision.action === "mark-paid";
}
