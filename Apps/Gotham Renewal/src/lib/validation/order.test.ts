/**
 * Order-request validation tests.
 *
 * The schema is a security control, so it is tested like one: the cases that
 * matter are the ones an attacker would try (missing fields, injected prices,
 * absurd quantities, malformed phone numbers).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrderSchema, fieldErrors, MAX_QUANTITY_PER_LINE } from "./order";

const validPayload = {
  customer: {
    name: "Raj Kumar",
    phone: "9876543210",
    email: "raj@example.com",
    address: "12 MG Road, Near the temple",
    city: "Bengaluru",
    state: "Karnataka",
    pincode: "560001",
  },
  paymentMethod: "COD",
  items: [{ productId: "123e4567-e89b-12d3-a456-426614174000", quantity: 2 }],
};

test("accepts a well-formed COD order", () => {
  const result = createOrderSchema.safeParse(validPayload);
  assert.ok(result.success);
  assert.equal(result.data.paymentMethod, "COD");
  assert.equal(result.data.items.length, 1);
});

test("accepts RAZORPAY as a payment method", () => {
  const result = createOrderSchema.safeParse({ ...validPayload, paymentMethod: "RAZORPAY" });
  assert.ok(result.success);
});

test("rejects an unknown payment method", () => {
  const result = createOrderSchema.safeParse({ ...validPayload, paymentMethod: "BITCOIN" });
  assert.ok(!result.success);
});

test("strips injected price and status fields from items", () => {
  const result = createOrderSchema.safeParse({
    ...validPayload,
    items: [{ productId: "123e4567-e89b-12d3-a456-426614174000", quantity: 1, price: 1, total: 1 }],
  });
  assert.ok(result.success);
  // The parsed item has only the fields the schema declares.
  assert.deepEqual(Object.keys(result.data.items[0]).sort(), ["productId", "quantity"]);
  assert.ok(!("price" in result.data.items[0]));
});

test("strips injected top-level money and status fields", () => {
  const result = createOrderSchema.safeParse({
    ...validPayload,
    subtotal: 1,
    total: 1,
    paymentStatus: "PAID",
    orderStatus: "DELIVERED",
  });
  assert.ok(result.success);
  assert.ok(!("total" in result.data));
  assert.ok(!("paymentStatus" in result.data));
  assert.ok(!("orderStatus" in result.data));
});

test("normalises phone numbers to the last 10 digits", () => {
  for (const phone of ["9876543210", "+919876543210", "+91 98765 43210", "098765-43210"]) {
    const result = createOrderSchema.safeParse({
      ...validPayload,
      customer: { ...validPayload.customer, phone },
    });
    assert.ok(result.success, `expected ${phone} to be accepted`);
    assert.equal(result.data.customer.phone, "9876543210");
  }
});

test("rejects malformed phone numbers", () => {
  for (const phone of ["12345", "1234567890", "5876543210", "abcdefghij", ""]) {
    const result = createOrderSchema.safeParse({
      ...validPayload,
      customer: { ...validPayload.customer, phone },
    });
    assert.ok(!result.success, `expected ${phone} to be rejected`);
  }
});

test("rejects a malformed pincode", () => {
  for (const pincode of ["12345", "012345", "abcdef", ""]) {
    const result = createOrderSchema.safeParse({
      ...validPayload,
      customer: { ...validPayload.customer, pincode },
    });
    assert.ok(!result.success, `expected ${pincode} to be rejected`);
  }
});

test("accepts an omitted or empty email but rejects a malformed one", () => {
  const { email, ...withoutEmail } = validPayload.customer;
  assert.ok(createOrderSchema.safeParse({ ...validPayload, customer: withoutEmail }).success);
  assert.ok(createOrderSchema.safeParse({ ...validPayload, customer: { ...validPayload.customer, email: "" } }).success);
  assert.ok(!createOrderSchema.safeParse({ ...validPayload, customer: { ...validPayload.customer, email: "not-an-email" } }).success);
  void email;
});

test("rejects an empty item list", () => {
  const result = createOrderSchema.safeParse({ ...validPayload, items: [] });
  assert.ok(!result.success);
});

test("rejects a non-UUID product id", () => {
  const result = createOrderSchema.safeParse({
    ...validPayload,
    items: [{ productId: "drop-table", quantity: 1 }],
  });
  assert.ok(!result.success);
});

test("bounds the quantity per line", () => {
  const tooMany = createOrderSchema.safeParse({
    ...validPayload,
    items: [{ productId: "123e4567-e89b-12d3-a456-426614174000", quantity: MAX_QUANTITY_PER_LINE + 1 }],
  });
  assert.ok(!tooMany.success);

  const atLimit = createOrderSchema.safeParse({
    ...validPayload,
    items: [{ productId: "123e4567-e89b-12d3-a456-426614174000", quantity: MAX_QUANTITY_PER_LINE }],
  });
  assert.ok(atLimit.success);
});

test("rejects negative, zero and fractional quantities", () => {
  for (const quantity of [0, -1, 1.5]) {
    const result = createOrderSchema.safeParse({
      ...validPayload,
      items: [{ productId: "123e4567-e89b-12d3-a456-426614174000", quantity }],
    });
    assert.ok(!result.success, `expected quantity ${quantity} to be rejected`);
  }
});

test("fieldErrors flattens issues into one message per field path", () => {
  const result = createOrderSchema.safeParse({
    ...validPayload,
    customer: { ...validPayload.customer, city: "", pincode: "abc" },
  });
  assert.ok(!result.success);
  const errors = fieldErrors(result.error);
  assert.ok(errors["customer.city"]);
  assert.ok(errors["customer.pincode"]);
  // One message per path, not an array.
  assert.equal(typeof errors["customer.city"], "string");
});
