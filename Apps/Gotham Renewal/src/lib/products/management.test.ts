/**
 * Product management tests.
 *
 * WHAT IS COVERED HERE, AND WHAT IS NOT.
 *
 * `management.ts` is almost entirely database-bound: every exported mutation
 * calls Prisma, and importing the module pulls in `@/lib/db`, which parses the
 * environment and opens a pool. The unit suite must stay database-free, so it
 * cannot import that module at all. The pure logic it depends on lives in
 * `src/lib/validation/product.ts` and is what this file tests:
 *
 *   - `normaliseSlug`   - lowercase/hyphen canonicalisation of a slug.
 *   - `normalisePricePaise` - the integer-paise guard.
 *   - the create/update schema's rupees -> paise conversion, which is what the
 *     service receives.
 *
 * WHAT NEEDS THE DATABASE and is therefore checked by
 * `scripts/check-products.ts` (run with `npx tsx scripts/check-products.ts`):
 *   - createProduct's P2002 duplicate-slug handling returning `slug-taken`;
 *   - updateProduct, setProductActive and setStock against real rows;
 *   - disabling a product removing it from the storefront query while the admin
 *     query still returns it;
 *   - a product referenced by an order item surviving a disable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createProductSchema, normalisePricePaise, normaliseSlug } from "@/lib/validation/product";

test("normaliseSlug lowercases and hyphenates", () => {
  assert.equal(normaliseSlug("Coir Doormat"), "coir-doormat");
  assert.equal(normaliseSlug("  Bamboo__Tray  "), "bamboo-tray");
  assert.equal(normaliseSlug("Tea/Coffee Set!"), "tea-coffee-set");
});

test("normaliseSlug collapses runs and trims edge hyphens", () => {
  assert.equal(normaliseSlug("--a---b--"), "a-b");
  assert.equal(normaliseSlug("!!!hello world!!!"), "hello-world");
  assert.equal(normaliseSlug(""), "");
});

test("normaliseSlug leaves an already-clean slug untouched", () => {
  assert.equal(normaliseSlug("coir-doormat"), "coir-doormat");
});

test("normalisePricePaise accepts a positive whole number of paise", () => {
  assert.equal(normalisePricePaise(45050), 45050);
  assert.equal(normalisePricePaise(1), 1);
});

test("normalisePricePaise refuses zero, negatives and fractions", () => {
  for (const paise of [0, -1, 450.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(normalisePricePaise(paise), null, `expected ${paise} to be refused`);
  }
});

test("the schema the service receives already yields integer paise", () => {
  const result = createProductSchema.safeParse({
    name: "Coir Doormat",
    slug: "coir-doormat",
    description: "",
    priceRupees: "450.50",
    stock: "0",
    imageUrl: "",
    active: true,
  });
  assert.ok(result.success);
  // The service only ever sees `price` in paise.
  assert.equal(result.data.price, 45050);
  assert.equal(normalisePricePaise(result.data.price), 45050);
});
