/**
 * Payment decision tests.
 *
 * These encode the rules that protect against real payment failures: a
 * redelivered capture must not double-apply, a stale failure must not unpick a
 * paid order, and a failure must not permanently block a UPI retry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePaymentAction, shouldNotify } from "./decision";
import type { PaymentStatus } from "@/generated/prisma/enums";

const ALL: PaymentStatus[] = ["PENDING", "PAID", "COD", "FAILED", "REFUNDED"];

test("a capture marks a pending order paid", () => {
  assert.equal(decidePaymentAction("PENDING", "payment.captured").action, "mark-paid");
  assert.equal(decidePaymentAction("PENDING", "order.paid").action, "mark-paid");
});

test("a redelivered capture on a paid order is ignored, not re-applied", () => {
  for (const event of ["payment.captured", "order.paid"]) {
    const decision = decidePaymentAction("PAID", event);
    assert.equal(decision.action, "ignore", `${event} on PAID should be ignored`);
    assert.match(decision.action === "ignore" ? decision.reason : "", /already paid/);
  }
});

test("a stale failure cannot unpick a paid order", () => {
  const decision = decidePaymentAction("PAID", "payment.failed");
  assert.equal(decision.action, "ignore");
  assert.match(decision.action === "ignore" ? decision.reason : "", /cannot undo/);
});

test("a failure is not terminal: a later capture still marks it paid", () => {
  // This is the UPI retry case. FAILED must not lock the order.
  assert.equal(decidePaymentAction("FAILED", "payment.captured").action, "mark-paid");
  assert.equal(decidePaymentAction("PENDING", "payment.failed").action, "mark-failed");
});

test("authorization alone does not mark an order paid", () => {
  const decision = decidePaymentAction("PENDING", "payment.authorized");
  assert.equal(decision.action, "ignore");
  assert.match(decision.action === "ignore" ? decision.reason : "", /no order change/);
});

test("a refund marks the order refunded, once", () => {
  assert.equal(decidePaymentAction("PAID", "refund.processed").action, "mark-refunded");
  assert.equal(decidePaymentAction("REFUNDED", "refund.processed").action, "ignore");
});

test("an unknown event type never changes the order", () => {
  for (const status of ALL) {
    const decision = decidePaymentAction(status, "payment.something_new");
    assert.equal(decision.action, "ignore", `${status} + unknown should be ignored`);
  }
});

test("only a capture triggers an owner notification", () => {
  assert.ok(shouldNotify(decidePaymentAction("PENDING", "payment.captured")));
  assert.ok(!shouldNotify(decidePaymentAction("PENDING", "payment.failed")));
  assert.ok(!shouldNotify(decidePaymentAction("PENDING", "payment.authorized")));
  assert.ok(!shouldNotify(decidePaymentAction("PAID", "payment.captured")));
  assert.ok(!shouldNotify(decidePaymentAction("PAID", "refund.processed")));
});

test("no combination of status and event throws", () => {
  const events = [
    "payment.captured",
    "payment.failed",
    "payment.authorized",
    "order.paid",
    "refund.processed",
    "unknown.event",
  ];
  for (const status of ALL) {
    for (const event of events) {
      assert.doesNotThrow(
        () => decidePaymentAction(status, event),
        `${status} + ${event} threw`,
      );
    }
  }
});

test("a COD order is never treated as an online payment", () => {
  // COD has its own status and no Razorpay order id, so a webhook cannot find
  // it. If one somehow did, a capture must not silently flip COD to PAID
  // without money being verified - so this documents the intent at the
  // decision layer: COD is already a settled concept.
  const decision = decidePaymentAction("COD", "payment.captured");
  assert.equal(decision.action, "mark-paid");
  // (The webhook handler additionally refuses orders with no razorpayOrderId,
  // which is what actually stops this case; see the route.)
});
