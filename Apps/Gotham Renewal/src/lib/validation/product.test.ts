/**
 * Product validation tests.
 *
 * These schemas are the trust boundary for the admin product forms, so they are
 * tested the way the order schema is (see order.test.ts): the cases that matter
 * are the ones that must not get through - a bad slug, a bad price, a negative
 * stock, an injected field.
 *
 * The money conversion is the point of this file. The form takes RUPEES and the
 * database stores PAISE, so the tests pin the exact conversion ("450.50" ->
 * 45050) and the exact rejections ("1.234", "0", "-5", "abc").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createProductSchema,
  MAX_PRICE_RUPEES,
  MAX_STOCK,
  SLUG_PATTERN,
} from "./product";
// `fieldErrors` already exists for the order schema - reuse it rather than
// duplicating a second, subtly different implementation.
import { fieldErrors } from "./order";

const validPayload = {
  name: "Coir Doormat",
  slug: "coir-doormat",
  description: "A doormat made of coir.",
  priceRupees: "450.50",
  stock: "12",
  imageUrl: "https://cdn.example.com/doormat.png",
  active: true,
};

test("accepts a well-formed product and converts rupees to paise", () => {
  const result = createProductSchema.safeParse(validPayload);
  assert.ok(result.success);
  assert.equal(result.data.price, 45050);
  assert.equal(result.data.stock, 12);
  assert.equal(result.data.slug, "coir-doormat");
  assert.equal(result.data.active, true);
});

test("converts a whole-rupee price and a price with one decimal", () => {
  const whole = createProductSchema.safeParse({ ...validPayload, priceRupees: "450" });
  assert.ok(whole.success);
  assert.equal(whole.data.price, 45000);

  const oneDecimal = createProductSchema.safeParse({ ...validPayload, priceRupees: "450.5" });
  assert.ok(oneDecimal.success);
  assert.equal(oneDecimal.data.price, 45050);
});

test("rejects zero, negative, non-numeric and over-precise prices", () => {
  for (const priceRupees of ["0", "-5", "abc", "1.234", "1e3", ""]) {
    const result = createProductSchema.safeParse({ ...validPayload, priceRupees });
    assert.ok(!result.success, `expected price ${JSON.stringify(priceRupees)} to be rejected`);
  }
});

test("rejects a price above the sanity cap", () => {
  const tooHigh = createProductSchema.safeParse({
    ...validPayload,
    priceRupees: String(MAX_PRICE_RUPEES + 1),
  });
  assert.ok(!tooHigh.success);

  const atCap = createProductSchema.safeParse({
    ...validPayload,
    priceRupees: String(MAX_PRICE_RUPEES),
  });
  assert.ok(atCap.success);
});

test("accepts valid slug shapes", () => {
  for (const slug of ["ab", "coir-doormat", "a1-b2-c3", "123"]) {
    const result = createProductSchema.safeParse({ ...validPayload, slug });
    assert.ok(result.success, `expected slug ${slug} to be accepted`);
  }
  assert.ok(SLUG_PATTERN.test("coir-doormat"));
});

test("rejects malformed slugs", () => {
  for (const slug of [
    "Coir-Doormat",
    "coir doormat",
    "coir_doormat",
    "-coir",
    "coir-",
    "coir--doormat",
    "a",
    "",
  ]) {
    const result = createProductSchema.safeParse({ ...validPayload, slug });
    assert.ok(!result.success, `expected slug ${JSON.stringify(slug)} to be rejected`);
  }
});

test("strips injected fields from the product payload", () => {
  const result = createProductSchema.safeParse({
    ...validPayload,
    id: "attacker-supplied",
    price: 1, // the PAISE field, injected directly
    createdAt: "1970-01-01T00:00:00Z",
  });
  assert.ok(result.success);
  // The parsed object has only the fields the schema declares, and `price` is
  // the one WE computed from the rupees string, not the injected 1.
  assert.equal(result.data.price, 45050);
  assert.ok(!("id" in result.data));
  assert.ok(!("createdAt" in result.data));
  assert.ok(!("priceRupees" in result.data));
});

test("treats an empty or omitted image URL as no image", () => {
  for (const imageUrl of ["", undefined]) {
    const result = createProductSchema.safeParse({ ...validPayload, imageUrl });
    assert.ok(result.success);
    assert.equal(result.data.imageUrl, null);
  }
});

test("rejects a non-http(s) image URL", () => {
  for (const imageUrl of ["ftp://example.com/x.png", "javascript:alert(1)", "not-a-url"]) {
    const result = createProductSchema.safeParse({ ...validPayload, imageUrl });
    assert.ok(!result.success, `expected imageUrl ${imageUrl} to be rejected`);
  }
});

test("rejects negative and fractional stock, and caps the maximum", () => {
  for (const stock of ["-1", "1.5", "abc", ""]) {
    const result = createProductSchema.safeParse({ ...validPayload, stock });
    assert.ok(!result.success, `expected stock ${JSON.stringify(stock)} to be rejected`);
  }
  const tooMuch = createProductSchema.safeParse({
    ...validPayload,
    stock: String(MAX_STOCK + 1),
  });
  assert.ok(!tooMuch.success);
  const zero = createProductSchema.safeParse({ ...validPayload, stock: "0" });
  assert.ok(zero.success);
  assert.equal(zero.data.stock, 0);
});

test("defaults active to true and description to empty when omitted", () => {
  const { active, description, ...rest } = validPayload;
  const result = createProductSchema.safeParse(rest);
  assert.ok(result.success);
  assert.equal(result.data.active, true);
  assert.equal(result.data.description, "");
  void active;
  void description;
});

test("bounds the product name", () => {
  for (const name of ["a", "x".repeat(201), ""]) {
    assert.ok(
      !createProductSchema.safeParse({ ...validPayload, name }).success,
      `expected name ${JSON.stringify(name)} to be rejected`,
    );
  }
});

test("fieldErrors reports one message per field path", () => {
  const result = createProductSchema.safeParse({
    ...validPayload,
    slug: "Bad Slug",
    priceRupees: "0",
  });
  assert.ok(!result.success);
  const errors = fieldErrors(result.error);
  assert.equal(typeof errors.slug, "string");
  assert.equal(typeof errors.priceRupees, "string");
});
