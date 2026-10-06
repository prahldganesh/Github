/**
 * Refund eligibility tests.
 *
 * The eligibility rule decides whether money leaves the business, so every
 * condition is asserted directly. It is a pure function, which is exactly why it
 * is written that way - the rule can be proven without a database or a provider.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { refundEligibility, refundIdempotencyKey } from "./refund-eligibility";

type Order = Parameters<typeof refundEligibility>[0];

const base: Order = {
  paymentMethod: "RAZORPAY",
  paymentStatus: "PAID",
  orderStatus: "CANCELLED",
  razorpayPaymentId: "pay_test_123",
};

test("a cancelled, paid online order is refundable", () => {
  assert.equal(refundEligibility(base), null);
});

test("a COD order is never refundable through the payment provider", () => {
  const problem = refundEligibility({ ...base, paymentMethod: "COD", paymentStatus: "COD" });
  assert.equal(problem?.kind, "cod-order");
});

test("an order with no payment id cannot be refunded", () => {
  const problem = refundEligibility({ ...base, razorpayPaymentId: null });
  assert.equal(problem?.kind, "no-payment-id");
});

test("an already-refunded order cannot be refunded again", () => {
  const problem = refundEligibility({ ...base, paymentStatus: "REFUNDED" });
  assert.equal(problem?.kind, "already-refunded");
});

test("an unpaid order cannot be refunded", () => {
  for (const paymentStatus of ["PENDING", "FAILED"] as const) {
    const problem = refundEligibility({ ...base, paymentStatus });
    assert.equal(problem?.kind, "not-paid", `paymentStatus ${paymentStatus} should block`);
  }
});

test("a paid order that is still being fulfilled is not refundable", () => {
  // The money is ours, but we are still delivering - refunding here would be
  // wrong, and this is the guard that stops a stray click.
  for (const orderStatus of ["NEW", "CONFIRMED", "PACKED", "SHIPPED", "DELIVERED"] as const) {
    const problem = refundEligibility({ ...base, orderStatus });
    assert.equal(problem?.kind, "not-refundable", `orderStatus ${orderStatus} should block`);
  }
});

test("only a cancelled AND paid online order passes every condition", () => {
  const passing: Order[] = [base];
  const failing: Order[] = [
    { ...base, orderStatus: "DELIVERED" },
    { ...base, orderStatus: "NEW" },
    { ...base, paymentStatus: "PENDING" },
    { ...base, paymentStatus: "FAILED" },
    { ...base, paymentStatus: "REFUNDED" },
    { ...base, paymentStatus: "COD" },
    { ...base, paymentMethod: "COD" },
    { ...base, razorpayPaymentId: null },
  ];
  for (const order of passing) assert.equal(refundEligibility(order), null);
  for (const order of failing) assert.notEqual(refundEligibility(order), null);
});

test("the idempotency key is deterministic per order and unique across orders", () => {
  // Deterministic is the whole point: two concurrent attempts must collide.
  assert.equal(refundIdempotencyKey("order-1"), refundIdempotencyKey("order-1"));
  assert.notEqual(refundIdempotencyKey("order-1"), refundIdempotencyKey("order-2"));
  assert.equal(refundIdempotencyKey("abc"), "refund:abc");
});
