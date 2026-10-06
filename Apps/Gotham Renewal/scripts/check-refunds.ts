/**
 * Refund check, against a real database and a stubbed provider.
 *
 * The properties under test are the ones that cost real money:
 *
 *   A. ELIGIBILITY - an unpaid, COD, delivered or already-refunded order cannot
 *      be refunded, and the reasons are accurate.
 *   B. IDEMPOTENCY - many concurrent clicks produce exactly ONE refund attempt
 *      and ONE provider call. This is the whole point of the unique
 *      `idempotency_key`; a sequential test would pass on broken code.
 *   C. SUCCESS - a captured payment refunds, the provider id is persisted, and
 *      the order moves to REFUNDED.
 *   D. DEFINITE FAILURE - a provider 4xx records FAILED, leaves the order PAID,
 *      and allows a retry (which is safe, because nothing moved).
 *   E. UNCERTAINTY - a timeout leaves the attempt PROCESSING, does NOT mark the
 *      order refunded, and is NOT blindly retried. This is the double-refund
 *      guard.
 *   F. RECONCILIATION - after a timeout, if the provider turns out to have the
 *      refund, it is recorded; if it does not, the attempt is failed and only
 *      then becomes retryable.
 *   G. NEVER MORE THAN CAPTURED - the amount sent is the order total, and a
 *      second distinct attempt for the same order is refused by the key.
 *
 * The provider is stubbed via `globalThis.fetch`, so no network call is made and
 * no credentials are needed. The stubbing is at the HTTP boundary, which means
 * the real client code - including `isUncertainOutcome` - is exercised.
 *
 * Run: npm run check:refunds   (needs Postgres)
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { withUtcSession } from "../src/lib/db/connection";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: withUtcSession(process.env.DATABASE_URL!) }),
});

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = "") {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const stamp = Date.now();
let refundCalls = 0;

type FetchBehaviour =
  | { kind: "success"; refundId: string }
  | { kind: "provider-4xx"; code: string; description: string }
  | { kind: "timeout" }
  | { kind: "list"; refunds: Array<{ id: string; amount: number; status: string; paymentId: string }> };

let behaviour: FetchBehaviour = { kind: "success", refundId: "rfnd_default" };

/** Install a fetch stub that mimics Razorpay's refund endpoints. */
function stubFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url.includes("/refund") && init?.method === "POST") {
      refundCalls += 1;
      if (behaviour.kind === "timeout") {
        const error = new Error("aborted");
        error.name = "TimeoutError";
        throw error;
      }
      if (behaviour.kind === "provider-4xx") {
        return new Response(
          JSON.stringify({ error: { code: behaviour.code, description: behaviour.description } }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      if (behaviour.kind === "success") {
        const body = JSON.parse(String(init.body)) as { amount: number };
        return new Response(
          JSON.stringify({
            id: behaviour.refundId,
            entity: "refund",
            amount: body.amount,
            currency: "INR",
            payment_id: "pay_stub",
            status: "processed",
            speed_processed: "normal",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    if (url.includes("/refunds") && (!init || init.method === "GET")) {
      const refunds = (behaviour.kind === "list" ? behaviour.refunds : []).map((refund) => ({
        id: refund.id,
        amount: refund.amount,
        status: refund.status,
        // Razorpay always returns payment_id on a refund entity, and our parser
        // requires it - omitting it here is what made the first version of this
        // check report a false failure.
        payment_id: refund.paymentId,
        currency: "INR",
      }));
      return new Response(JSON.stringify({ entity: "collection", count: refunds.length, items: refunds }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: { code: "UNEXPECTED", description: url } }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function makeOrder(options: {
  suffix: string;
  paymentStatus: "PAID" | "PENDING" | "COD" | "FAILED" | "REFUNDED";
  orderStatus: "NEW" | "CANCELLED" | "DELIVERED";
  paymentMethod?: "COD" | "RAZORPAY";
  paymentId?: string | null;
}): Promise<{ id: string; orderNumber: string }> {
  const order = await prisma.order.create({
    data: {
      orderNumber: `RF-${options.suffix}-${stamp}`,
      customerName: "Refund Check",
      customerPhone: "9876543210",
      address: "1 Refund Road, Somewhere",
      city: "Bengaluru",
      state: "Karnataka",
      pincode: "560001",
      subtotal: 45050,
      shipping: 0,
      total: 45050,
      paymentMethod: options.paymentMethod ?? "RAZORPAY",
      paymentStatus: options.paymentStatus,
      orderStatus: options.orderStatus,
      razorpayPaymentId:
        options.paymentId === undefined ? `pay_stub_${options.suffix}_${stamp}` : options.paymentId,
    },
  });
  return { id: order.id, orderNumber: order.orderNumber };
}

async function main() {
  const restore = stubFetch();

  try {
    // Import AFTER the stub is installed, so the module binds the stubbed fetch.
    const { issueRefund, reconcileRefund, listRefundsForOrder } = await import(
      "../src/lib/payments/refunds"
    );

    // --- A. eligibility -----------------------------------------------------
    const unpaid = await makeOrder({ suffix: "A1", paymentStatus: "PENDING", orderStatus: "CANCELLED" });
    const delivered = await makeOrder({ suffix: "A2", paymentStatus: "PAID", orderStatus: "DELIVERED" });
    const cod = await makeOrder({
      suffix: "A3", paymentStatus: "COD", orderStatus: "CANCELLED", paymentMethod: "COD", paymentId: null,
    });
    const noPaymentId = await makeOrder({ suffix: "A4", paymentStatus: "PAID", orderStatus: "CANCELLED", paymentId: null });

    const unpaidResult = await issueRefund(unpaid.id);
    const deliveredResult = await issueRefund(delivered.id);
    const codResult = await issueRefund(cod.id);
    const noPaymentIdResult = await issueRefund(noPaymentId.id);

    check("an unpaid order cannot be refunded", !unpaidResult.ok && unpaidResult.problem.kind === "not-paid", unpaidResult.ok ? "allowed" : unpaidResult.problem.kind);
    check("a paid but delivered order is not refundable", !deliveredResult.ok && deliveredResult.problem.kind === "not-refundable", deliveredResult.ok ? "allowed" : deliveredResult.problem.kind);
    check("a COD order is not refundable online", !codResult.ok && codResult.problem.kind === "cod-order", codResult.ok ? "allowed" : codResult.problem.kind);
    check("an order with no payment id cannot be refunded", !noPaymentIdResult.ok && noPaymentIdResult.problem.kind === "no-payment-id", noPaymentIdResult.ok ? "allowed" : noPaymentIdResult.problem.kind);
    check("no provider call was made for any ineligible order", refundCalls === 0, `calls=${refundCalls}`);

    // --- B. concurrent duplicate clicks -> one attempt, one call ------------
    const target = await makeOrder({ suffix: "B", paymentStatus: "PAID", orderStatus: "CANCELLED" });
    behaviour = { kind: "success", refundId: `rfnd_${stamp}_ok` };
    refundCalls = 0;

    const CONCURRENCY = 8;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => issueRefund(target.id)),
    );
    const succeeded = results.filter((r) => r.ok).length;
    const refused = results.filter((r) => !r.ok).length;
    const attempts = await listRefundsForOrder(target.id);

    check("exactly one of many concurrent refund clicks succeeds", succeeded === 1, `ok=${succeeded}, refused=${refused}`);
    check("exactly one provider refund call was made", refundCalls === 1, `calls=${refundCalls}`);
    check("exactly one refund row exists for the order", attempts.length === 1, `rows=${attempts.length}`);
    check("the attempt is SUCCEEDED", attempts[0]?.status === "SUCCEEDED", `status=${attempts[0]?.status}`);
    check("the provider refund id was persisted", attempts[0]?.providerRefundId === `rfnd_${stamp}_ok`, `id=${attempts[0]?.providerRefundId}`);
    check("the amount refunded equals the order total (never more)", attempts[0]?.amount === 45050, `amount=${attempts[0]?.amount}`);

    // --- C. the order moved to REFUNDED ------------------------------------
    const afterRefund = await prisma.order.findUnique({ where: { id: target.id } });
    check("the order's payment status became REFUNDED", afterRefund?.paymentStatus === "REFUNDED", `paymentStatus=${afterRefund?.paymentStatus}`);

    // --- D. a subsequent click is refused ----------------------------------
    refundCalls = 0;
    const secondClick = await issueRefund(target.id);
    check("a later click on an already-refunded order is refused", !secondClick.ok && secondClick.problem.kind === "already-refunded", secondClick.ok ? "allowed" : secondClick.problem.kind);
    check("no second provider call was made", refundCalls === 0, `calls=${refundCalls}`);

    // --- E. a definite provider failure ------------------------------------
    const failTarget = await makeOrder({ suffix: "E", paymentStatus: "PAID", orderStatus: "CANCELLED" });
    behaviour = { kind: "provider-4xx", code: "BAD_REQUEST_ERROR", description: "payment is not captured" };
    refundCalls = 0;

    const failed = await issueRefund(failTarget.id);
    const failedAttempt = (await listRefundsForOrder(failTarget.id))[0];
    const failOrder = await prisma.order.findUnique({ where: { id: failTarget.id } });

    check("a provider 4xx is reported as a failure", !failed.ok && failed.problem.kind === "provider-error", failed.ok ? "ok" : failed.problem.kind);
    check("the attempt is recorded as FAILED", failedAttempt?.status === "FAILED", `status=${failedAttempt?.status}`);
    check("the error is persisted, not swallowed", !!failedAttempt?.lastError, failedAttempt?.lastError?.slice(0, 40));
    check("the order was NOT marked refunded", failOrder?.paymentStatus === "PAID", `paymentStatus=${failOrder?.paymentStatus}`);

    // A retry after a definite failure is safe, and reuses the row.
    behaviour = { kind: "success", refundId: `rfnd_${stamp}_retry` };
    refundCalls = 0;
    const retry = await issueRefund(failTarget.id);
    const rowsAfterRetry = await listRefundsForOrder(failTarget.id);
    check("a retry after a definite failure is allowed", retry.ok, retry.ok ? "ok" : retry.problem.kind);
    check("the retry reuses the one row rather than duplicating", rowsAfterRetry.length === 1, `rows=${rowsAfterRetry.length}`);
    check("the retry recorded the attempt count", rowsAfterRetry[0]?.attempts === 2, `attempts=${rowsAfterRetry[0]?.attempts}`);

    // --- F. uncertainty: a timeout must NOT be retried blindly -------------
    const timeoutTarget = await makeOrder({ suffix: "F", paymentStatus: "PAID", orderStatus: "CANCELLED" });
    const timeoutPaymentId = `pay_stub_F_${stamp}`;
    behaviour = { kind: "timeout" };
    refundCalls = 0;

    const timedOut = await issueRefund(timeoutTarget.id);
    const timeoutAttempt = (await listRefundsForOrder(timeoutTarget.id))[0];
    const timeoutOrder = await prisma.order.findUnique({ where: { id: timeoutTarget.id } });

    check("a timeout is reported as uncertain, not as failure", !timedOut.ok && timedOut.problem.kind === "uncertain", timedOut.ok ? "ok" : timedOut.problem.kind);
    check("the attempt is left PROCESSING (outcome unknown)", timeoutAttempt?.status === "PROCESSING", `status=${timeoutAttempt?.status}`);
    check("the order is NOT marked refunded on a timeout", timeoutOrder?.paymentStatus === "PAID", `paymentStatus=${timeoutOrder?.paymentStatus}`);

    // Clicking again during uncertainty must be refused, not resent.
    refundCalls = 0;
    const againDuringUncertainty = await issueRefund(timeoutTarget.id);
    check("re-clicking during uncertainty is refused", !againDuringUncertainty.ok && againDuringUncertainty.problem.kind === "already-in-progress", againDuringUncertainty.ok ? "allowed" : againDuringUncertainty.problem.kind);
    check("no second provider call during uncertainty (the double-refund guard)", refundCalls === 0, `calls=${refundCalls}`);

    // --- G. reconciliation ---------------------------------------------------
    // The provider turns out to have the refund: it must be recorded.
    behaviour = {
      kind: "list",
      refunds: [{ id: `rfnd_${stamp}_found`, amount: 45050, status: "processed", paymentId: timeoutPaymentId }],
    };
    const reconciled = await reconcileRefund(timeoutTarget.id);
    const reconciledAttempt = (await listRefundsForOrder(timeoutTarget.id))[0];
    const reconciledOrder = await prisma.order.findUnique({ where: { id: timeoutTarget.id } });

    check("reconciliation finds a refund the provider does have", reconciled.status === "SUCCEEDED", `${reconciled.status}: ${reconciled.detail}`);
    check("the found refund id is recorded", reconciledAttempt?.providerRefundId === `rfnd_${stamp}_found`, `id=${reconciledAttempt?.providerRefundId}`);
    check("the order is marked refunded after reconciliation", reconciledOrder?.paymentStatus === "REFUNDED", `paymentStatus=${reconciledOrder?.paymentStatus}`);

    // The provider has nothing: only then is the attempt safely failed.
    const neverSent = await makeOrder({ suffix: "G", paymentStatus: "PAID", orderStatus: "CANCELLED" });
    behaviour = { kind: "timeout" };
    await issueRefund(neverSent.id);
    behaviour = { kind: "list", refunds: [] };
    const reconciledEmpty = await reconcileRefund(neverSent.id);
    const neverSentAttempt = (await listRefundsForOrder(neverSent.id))[0];

    check("reconciliation with no provider record marks the attempt FAILED", reconciledEmpty.status === "FAILED", `${reconciledEmpty.status}`);
    check("only then does it become retryable", neverSentAttempt?.status === "FAILED", `status=${neverSentAttempt?.status}`);

    behaviour = { kind: "success", refundId: `rfnd_${stamp}_after-reconcile` };
    const afterReconcile = await issueRefund(neverSent.id);
    check("the retry after reconciliation succeeds", afterReconcile.ok, afterReconcile.ok ? "ok" : afterReconcile.problem.kind);
  } finally {
    restore();
    await prisma.order.deleteMany({ where: { customerName: "Refund Check" } });
    await prisma.$disconnect();
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
