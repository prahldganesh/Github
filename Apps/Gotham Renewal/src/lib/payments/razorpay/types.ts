/**
 * Razorpay payment layer - types only.
 *
 * Vocabulary follows CONTEXT.md: a "Razorpay Order ID" is Razorpay's own order
 * identifier, a "Razorpay Payment ID" is the payment that arrives on the
 * webhook, and a "Payment Event" is one notification we have processed.
 *
 * All money is integer paise (see `@/lib/money`). The module never reads env:
 * configuration is passed in, so it stays pure and testable.
 */

/** Server-side credentials. `keySecret` and `webhookSecret` must never be logged or returned. */
export type RazorpayConfig = {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  /** Override for tests / staging; defaults to https://api.razorpay.com. */
  baseUrl?: string;
};

export type CreateRazorpayOrderInput = {
  /** Charge amount in paise. A positive integer; Razorpay's minimum is 100 (INR 1.00). */
  amountPaise: number;
  /** Our orderNumber, <=40 chars and unique per Razorpay account. */
  receipt: string;
  /** Correlation pairs, e.g. { local_order_id, order_number }. At most 15 pairs. */
  notes?: Record<string, string>;
};

/** The subset of the Razorpay Orders entity this app needs. */
export type RazorpayOrder = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  receipt: string | null;
};

/** The subset of the Razorpay Payment entity this app needs. */
export type RazorpayPayment = {
  id: string;
  orderId: string | null;
  amount: number;
  currency: string;
  status: string;
};

/** Every failure is returned, never thrown, so callers can branch on it. */
export type RazorpayError = {
  /** Our own code ("INVALID_AMOUNT", "NETWORK_ERROR", "TIMEOUT", "INVALID_RESPONSE") or Razorpay's. */
  code: string;
  description: string;
  /** HTTP status when the failure came from a response. */
  status?: number;
};

export type CreateOrderResult =
  | { ok: true; order: RazorpayOrder }
  | { ok: false; error: RazorpayError };

export type FetchPaymentResult =
  | { ok: true; payment: RazorpayPayment }
  | { ok: false; error: RazorpayError };

/**
 * The subset of the Razorpay Refund entity this app needs.
 *
 * `status` is the provider's own vocabulary:
 *   `pending`   - Razorpay is attempting it
 *   `processed` - the final, successful state
 *   `failed`    - it will not happen
 * Note it is NOT the same as our `RefundStatus`.
 */
export type RazorpayRefund = {
  id: string;
  paymentId: string;
  amount: number;
  currency: string;
  status: string;
  /** `normal` | `instant`, when the provider reports it. */
  speedProcessed: string | null;
};

export type CreateRefundResult =
  | { ok: true; refund: RazorpayRefund }
  | { ok: false; error: RazorpayError };

export type FetchRefundResult =
  | { ok: true; refund: RazorpayRefund }
  | { ok: false; error: RazorpayError };

/** Why a webhook signature failed. */
export type VerificationFailureReason =
  | "missing-signature"
  | "missing-secret"
  | "length-mismatch"
  | "invalid-signature";

/** Result of verifying a webhook. An invalid signature returns `ok: false`; it never throws. */
export type VerificationResult =
  | { ok: true }
  | { ok: false; reason: VerificationFailureReason };

/**
 * The webhook fields the app needs, extracted defensively.
 *
 * Note: `payment.failed` is NOT terminal. Razorpay may send a later
 * `payment.captured` for the same payment (e.g. a UPI retry), so consumers
 * must allow a failure to be superseded by a capture.
 */
export type ParsedWebhookEvent = {
  /** e.g. "payment.captured", "payment.failed", "order.paid". */
  event: string;
  paymentId: string | null;
  /** Extracted from `payment.order_id`, falling back to the order entity's id. */
  orderId: string | null;
  amountPaise: number | null;
  currency: string | null;
  status: string | null;
  receipt: string | null;
};
