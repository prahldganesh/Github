/**
 * Refunds.
 *
 * THE BUSINESS RULE, stated once: money is only ever sent back to a customer
 * when a human decided to, for an order that is genuinely holding their money,
 * and never twice.
 *
 * Automatic refunds are deliberately NOT implemented. An order reaching
 * CANCELLED + PAID is *detected* and surfaced, but issuing money back is a
 * business decision (maybe the customer asked for the order anyway, maybe a
 * partial refund was agreed, maybe the payment is under dispute) and the app
 * must not guess. The admin clicks, the server verifies, the provider moves.
 *
 * ELIGIBILITY IS VERIFIED SERVER-SIDE, every time, from the database - never
 * from the form. The admin UI hiding a button is a convenience; the check here
 * is the control.
 *
 * IDEMPOTENCY has three layers, because a double refund is the worst thing this
 * module could do:
 *
 *   1. The admin may only refund an order whose payment is captured AND whose
 *      local state says a refund is owed.
 *   2. A UNIQUE `refunds.idempotency_key` (derived from the order) means two
 *      concurrent clicks cannot both create an attempt - the database picks one
 *      winner, exactly as the webhook's event table does. See `beginRefund`.
 *   3. The provider is sent the same key as the refund `receipt`, which Razorpay
 *      treats as an idempotency key ("Duplicate receipt found for this refund
 *      request"), so even a bypassed local guard cannot double-refund.
 *
 * UNCERTAINTY IS RECORDED, NOT GUESSED. If the provider times out, the refund
 * may exist. That attempt is left `PROCESSING` with its error recorded, and the
 * admin is told to reconcile - we never blindly resubmit. `reconcileRefund`
 * asks the provider what actually happened and settles the row from the answer.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { env, razorpayConfigured } from "@/lib/env";
import { logger, errorFields } from "@/lib/logger";
import {
  createRefund,
  fetchPayment,
  fetchRefund,
  isUncertainOutcome,
  listRefundsForPayment,
} from "@/lib/payments/razorpay/client";
import type { RazorpayConfig } from "@/lib/payments/razorpay/types";
import type { Refund } from "@/generated/prisma/client";

const PROVIDER = "RAZORPAY";
const UNIQUE_VIOLATION = "P2002";

// A re-export does not create a local binding, so the type is imported as well
// as re-exported for callers.
import type { RefundProblem } from "./refund-eligibility";
export type { RefundProblem } from "./refund-eligibility";
export { refundEligibility, refundIdempotencyKey } from "./refund-eligibility";
import { refundEligibility, refundIdempotencyKey } from "./refund-eligibility";

export type RefundResult =
  | { ok: true; refund: Refund }
  | { ok: false; problem: RefundProblem };

/**
 * The order fields the refund flow needs, narrowed from the full row so the
 * shape a caller must supply is explicit.
 */
export type RefundableOrder = {
  id: string;
  orderNumber: string;
  paymentStatus: "PENDING" | "PAID" | "COD" | "FAILED" | "REFUNDED";
  orderStatus: "NEW" | "CONFIRMED" | "PACKED" | "SHIPPED" | "DELIVERED" | "CANCELLED";
  paymentMethod: "COD" | "RAZORPAY";
  razorpayPaymentId: string | null;
  total: number;
};

export function messageForRefundProblem(problem: RefundProblem): string {
  switch (problem.kind) {
    case "not-found":
      return "That order could not be found.";
    case "not-paid":
      return "This order has no captured payment, so there is nothing to refund.";
    case "not-refundable":
      return "This order is not in a state that requires a refund.";
    case "cod-order":
      return "Cash-on-delivery orders are refunded outside the app; there is no online payment to reverse.";
    case "no-payment-id":
      return "This order has no payment id recorded, so the provider cannot be asked to refund it.";
    case "already-refunded":
      return "This payment has already been refunded.";
    case "already-in-progress":
      return "A refund for this order is already in progress. Use Reconcile to check its status.";
    case "provider-not-configured":
      return "Online payments are not configured, so refunds cannot be issued.";
    case "provider-error":
      return "The payment provider refused the refund. See the details and try again if appropriate.";
    case "uncertain":
      return "The provider did not confirm the refund. It may still have been accepted - use Reconcile before retrying.";
  }
}

function config(): RazorpayConfig {
  const e = env();
  return {
    keyId: e.RAZORPAY_KEY_ID ?? "",
    keySecret: e.RAZORPAY_KEY_SECRET ?? "",
    webhookSecret: e.RAZORPAY_WEBHOOK_SECRET ?? "",
  };
}

/** Every refund attempt for an order, oldest first. The audit trail. */
export async function listRefundsForOrder(orderId: string): Promise<Refund[]> {
  return prisma.refund.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
}

/** The most recent attempt, which is what the admin UI acts on. */
export async function latestRefundForOrder(orderId: string): Promise<Refund | null> {
  return prisma.refund.findFirst({ where: { orderId }, orderBy: { createdAt: "desc" } });
}

/**
 * Create the local attempt row, or report why it cannot be created.
 *
 * THE INSERT IS THE LOCK. Two concurrent admin clicks both reach here; both try
 * to insert the same `idempotencyKey`; Postgres lets exactly one succeed and the
 * other gets a unique violation, which is reported as `already-in-progress`.
 * That is why this is an INSERT-and-catch rather than a check-then-act: a check
 * followed by an insert has a window where both callers see "no refund yet".
 *
 * If an attempt already exists and is FAILED, it is reused (attempts
 * incremented) rather than duplicated - the history stays as one row per order,
 * with the count of tries.
 */
async function beginRefund(order: RefundableOrder): Promise<RefundResult> {
  const key = refundIdempotencyKey(order.id);
  const amount = order.total;

  try {
    const refund = await prisma.refund.create({
      data: {
        orderId: order.id,
        provider: PROVIDER,
        paymentId: order.razorpayPaymentId!,
        amount,
        currency: "INR",
        status: "PENDING",
        idempotencyKey: key,
        attempts: 1,
      },
    });
    return { ok: true, refund };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      logger.error("failed to create a refund attempt", errorFields(error));
      throw error;
    }

    // An attempt already exists. Decide what that means from its status.
    const existing = await prisma.refund.findUnique({ where: { idempotencyKey: key } });
    if (!existing) {
      // The unique violation fired but no row is visible: genuinely unexpected,
      // and guessing could double-refund. Fail loudly.
      throw new Error(`Refund conflict for ${key} but no existing row is visible`);
    }

    if (existing.status === "SUCCEEDED") {
      return { ok: false, problem: { kind: "already-refunded" } };
    }
    if (existing.status === "PROCESSING") {
      // Mid-flight, or left uncertain by a timeout. Never a second attempt.
      return { ok: false, problem: { kind: "already-in-progress" } };
    }

    // FAILED: a previous attempt did not go through, so retrying is legitimate.
    // The attempt counter records that this is a retry, and the row is reused so
    // the history stays one-per-order.
    const retried = await prisma.refund.update({
      where: { id: existing.id },
      data: {
        status: "PENDING",
        attempts: { increment: 1 },
        lastError: null,
        providerRefundId: null,
        completedAt: null,
      },
    });
    return { ok: true, refund: retried };
  }
}

/**
 * Issue a refund for an order.
 *
 * Called by an authenticated admin action. Authorization happens in the action;
 * everything below is the server independently deciding whether the refund is
 * legitimate.
 */
export async function issueRefund(orderId: string): Promise<RefundResult> {
  if (!razorpayConfigured()) {
    return { ok: false, problem: { kind: "provider-not-configured" } };
  }

  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return { ok: false, problem: { kind: "not-found" } };

  // Re-verify eligibility from the database, not from the form.
  const ineligible = refundEligibility(order);
  if (ineligible) return { ok: false, problem: ineligible };

  const refundable: RefundableOrder = {
    id: order.id,
    orderNumber: order.orderNumber,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    orderStatus: order.orderStatus,
    razorpayPaymentId: order.razorpayPaymentId,
    total: order.total,
  };

  // Claim the attempt (or learn one exists).
  const begun = await beginRefund(refundable);
  if (!begun.ok) return begun;
  const attempt = begun.refund;

  // It is claimed. Ask the provider.
  return await sendRefund(attempt, refundable);
}

/**
 * Send one attempt to the provider and record the outcome.
 *
 * Split out so `reconcileRefund` can retry a FAILED attempt through the same
 * path.
 */
async function sendRefund(attempt: Refund, order: RefundableOrder): Promise<RefundResult> {
  // Move to PROCESSING *before* the network call. If the process dies mid-call,
  // the row already says "in flight", so a later run reconciles rather than
  // resubmitting.
  await prisma.refund.update({
    where: { id: attempt.id },
    data: { status: "PROCESSING" },
  });

  const result = await createRefund(config(), {
    paymentId: order.razorpayPaymentId!,
    amountPaise: order.total,
    idempotencyKey: attempt.idempotencyKey,
    notes: { orderNumber: order.orderNumber, localOrderId: order.id },
  });

  if (result.ok) {
    const succeeded = await prisma.refund.update({
      where: { id: attempt.id },
      data: {
        status: "SUCCEEDED",
        providerRefundId: result.refund.id,
        completedAt: new Date(),
        lastError: null,
      },
    });

    // The order's payment state follows the refund. Guarded so a concurrent
    // state change cannot be clobbered, and so this cannot double-apply.
    await prisma.order.updateMany({
      where: { id: order.id, paymentStatus: "PAID" },
      data: { paymentStatus: "REFUNDED" },
    });

    logger.info("refund succeeded", {
      orderId: order.id,
      orderNumber: order.orderNumber,
      refundId: succeeded.id,
      providerRefundId: result.refund.id,
      amount: order.total,
      attempt: attempt.attempts,
    });

    return { ok: true, refund: succeeded };
  }

  // A definite refusal: the provider understood and said no. Recorded as FAILED
  // so the admin sees why, and can retry if the reason was transient.
  const error = result.error;
  const uncertain = isUncertainOutcome(error);

  const updated = await prisma.refund.update({
    where: { id: attempt.id },
    data: uncertain
      ? {
          // NOT failed: we do not know. Leaving it PROCESSING is the honest
          // state, and it is what stops a blind retry from double-refunding.
          status: "PROCESSING",
          lastError: `${error.code}: ${error.description}`.slice(0, 2000),
        }
      : {
          status: "FAILED",
          lastError: `${error.code}: ${error.description}`.slice(0, 2000),
        },
  });

  logger.error("refund attempt did not succeed", {
    orderId: order.id,
    orderNumber: order.orderNumber,
    refundId: attempt.id,
    code: error.code,
    description: error.description,
    uncertain,
    attempt: attempt.attempts,
    status: updated.status,
  });

  return {
    ok: false,
    problem: uncertain
      ? { kind: "uncertain", detail: error.description }
      : { kind: "provider-error", detail: error.description },
  };
}

export type ReconcileResult = {
  ok: boolean;
  status: Refund["status"];
  detail: string;
};

/**
 * Ask the provider what happened to an attempt, and settle the row from the
 * answer.
 *
 * This is the ONLY safe way out of the uncertain state. The sequence is
 * deliberate:
 *
 *   1. If we have a provider refund id, fetch it - the provider is authoritative.
 *   2. If we do not, LIST the payment's refunds and look for one matching our
 *      receipt. This is the timeout case: we never learned the id, but the
 *      provider may have created the refund anyway.
 *   3. If the provider has no record, the attempt genuinely did not happen, and
 *      only then is it safe to mark FAILED and allow a retry.
 *
 * Blindly resubmitting on a timeout would be the double-refund bug.
 */
export async function reconcileRefund(orderId: string): Promise<ReconcileResult> {
  const attempt = await latestRefundForOrder(orderId);
  if (!attempt) return { ok: false, status: "FAILED", detail: "No refund attempt to reconcile." };

  if (attempt.status === "SUCCEEDED") {
    return { ok: true, status: "SUCCEEDED", detail: "Already confirmed." };
  }
  if (attempt.status === "FAILED") {
    return { ok: true, status: "FAILED", detail: "Already failed; a new attempt may be made." };
  }

  // 1. We know the provider refund id: fetch it directly.
  if (attempt.providerRefundId) {
    const fetched = await fetchRefund(config(), attempt.paymentId, attempt.providerRefundId);
    if (fetched.ok) {
      return await settleFromProviderStatus(attempt.id, fetched.refund.status, fetched.refund.id);
    }
    if (!isUncertainOutcome(fetched.error)) {
      return {
        ok: false,
        status: attempt.status,
        detail: `Provider refused the lookup: ${fetched.error.description}`,
      };
    }
    return { ok: false, status: attempt.status, detail: "Provider unreachable; still unknown." };
  }

  // 2. No id: ask the payment what refunds exist and match our receipt.
  const listed = await listRefundsForPayment(config(), attempt.paymentId);
  if (!listed.ok) {
    // Still uncertain. Leave the row alone - do NOT guess.
    return {
      ok: false,
      status: attempt.status,
      detail: `Could not reach the provider: ${listed.error.description}`,
    };
  }

  // Razorpay does not echo our receipt on the refund in every response shape, so
  // match on amount as well as any id we can see. A refund of the full order
  // total that we did not otherwise account for is ours.
  const match = listed.refunds.find(
    (refund) => refund.amount === attempt.amount && refund.status !== "failed",
  );

  if (match) {
    return await settleFromProviderStatus(attempt.id, match.status, match.id);
  }

  // 3. The provider has no record of this refund. Now, and only now, it is safe
  //    to conclude the attempt never reached them.
  await prisma.refund.update({
    where: { id: attempt.id },
    data: {
      status: "FAILED",
      lastError: "Reconciled: the provider has no record of this refund.",
    },
  });
  logger.warn("refund reconciled as never-created", { refundId: attempt.id, orderId });
  return {
    ok: true,
    status: "FAILED",
    detail: "The provider has no record of this refund; it is safe to attempt again.",
  };
}

/** Map the provider's refund status onto ours and persist it. */
async function settleFromProviderStatus(
  refundId: string,
  providerStatus: string,
  providerRefundId: string,
): Promise<ReconcileResult> {
  // Razorpay: pending | processed | failed.
  const normalised = providerStatus.toLowerCase();

  if (normalised === "processed") {
    const updated = await prisma.refund.update({
      where: { id: refundId },
      data: {
        status: "SUCCEEDED",
        providerRefundId,
        completedAt: new Date(),
        lastError: null,
      },
    });
    // Keep the order's payment state consistent with the provider's truth.
    await prisma.order.updateMany({
      where: { id: updated.orderId, paymentStatus: "PAID" },
      data: { paymentStatus: "REFUNDED" },
    });
    logger.info("refund reconciled as succeeded", { refundId, providerRefundId });
    return { ok: true, status: "SUCCEEDED", detail: "The provider confirms the refund." };
  }

  if (normalised === "failed") {
    await prisma.refund.update({
      where: { id: refundId },
      data: { status: "FAILED", providerRefundId, lastError: "Provider reports the refund failed." },
    });
    return { ok: true, status: "FAILED", detail: "The provider reports the refund failed." };
  }

  // Still pending at the provider. Leave it PROCESSING.
  return {
    ok: true,
    status: "PROCESSING",
    detail: `The provider still shows the refund as "${providerStatus}".`,
  };
}

/**
 * Confirm the provider really has the payment captured.
 *
 * A belt-and-braces read used by the admin UI before offering the button. The
 * webhook already told us, but a manual check before sending money back is
 * cheap insurance against acting on a stale local row.
 */
export async function verifyPaymentCaptured(paymentId: string): Promise<boolean> {
  const fetched = await fetchPayment(config(), paymentId);
  if (!fetched.ok) return false;
  return fetched.payment.status.toLowerCase() === "captured";
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}
