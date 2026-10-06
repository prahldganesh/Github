/**
 * Pricing tests.
 *
 * The pricing module is the authority on what a customer owes, so these are the
 * most important unit tests in the project. They run with no database: the
 * whole point of keeping `priceOrder` pure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeShipping, priceOrder, type PricedProduct } from "./pricing";

const oil: PricedProduct = {
  id: "p-oil",
  name: "Coconut Oil",
  slug: "coconut-oil",
  price: 45000, // Rs.450.00
  stock: 10,
  active: true,
};

const honey: PricedProduct = {
  id: "p-honey",
  name: "Wild Honey",
  slug: "wild-honey",
  price: 38000, // Rs.380.00
  stock: 2,
  active: true,
};

const inactive: PricedProduct = {
  id: "p-old",
  name: "Discontinued",
  slug: "discontinued",
  price: 10000,
  stock: 5,
  active: false,
};

const freeShipping = { shippingFeePaise: 0, freeShippingThresholdPaise: 0 };
const flatShipping = { shippingFeePaise: 5000, freeShippingThresholdPaise: 0 };

test("prices a single line from the database price, not the request", () => {
  const result = priceOrder([oil], [{ productId: "p-oil", quantity: 2 }], freeShipping);
  assert.ok(result.ok);
  assert.equal(result.subtotalPaise, 90000); // 2 x 450.00
  assert.equal(result.totalPaise, 90000);
  assert.equal(result.lines[0].unitPrice, 45000);
  assert.equal(result.lines[0].total, 90000);
});

test("sums multiple lines in integer paise", () => {
  const result = priceOrder(
    [oil, honey],
    [
      { productId: "p-oil", quantity: 2 },
      { productId: "p-honey", quantity: 1 },
    ],
    freeShipping,
  );
  assert.ok(result.ok);
  // 2 x 45000 + 1 x 38000 = 128000  (Rs.1,280.00)
  assert.equal(result.subtotalPaise, 128000);
});

test("adds a flat shipping fee", () => {
  const result = priceOrder([oil], [{ productId: "p-oil", quantity: 1 }], flatShipping);
  assert.ok(result.ok);
  assert.equal(result.subtotalPaise, 45000);
  assert.equal(result.shippingPaise, 5000);
  assert.equal(result.totalPaise, 50000);
});

test("free shipping above the threshold, charged below it", () => {
  const config = { shippingFeePaise: 5000, freeShippingThresholdPaise: 50000 };
  const below = priceOrder([honey], [{ productId: "p-honey", quantity: 1 }], config);
  const above = priceOrder([oil], [{ productId: "p-oil", quantity: 2 }], config);
  assert.ok(below.ok && above.ok);
  assert.equal(below.shippingPaise, 5000); // 380.00 < 500.00
  assert.equal(above.shippingPaise, 0); // 900.00 >= 500.00
  assert.equal(above.totalPaise, 90000);
});

test("the threshold is inclusive (subtotal exactly at threshold ships free)", () => {
  const config = { shippingFeePaise: 5000, freeShippingThresholdPaise: 45000 };
  const result = priceOrder([oil], [{ productId: "p-oil", quantity: 1 }], config);
  assert.ok(result.ok);
  assert.equal(result.shippingPaise, 0);
});

test("computeShipping treats a 0 threshold as disabled and a 0 fee as always free", () => {
  assert.equal(computeShipping(1, { shippingFeePaise: 5000, freeShippingThresholdPaise: 0 }), 5000);
  assert.equal(computeShipping(999999, { shippingFeePaise: 0, freeShippingThresholdPaise: 100 }), 0);
});

test("rejects an empty cart", () => {
  const result = priceOrder([oil], [], freeShipping);
  assert.ok(!result.ok);
  assert.equal(result.problem.kind, "empty");
});

test("rejects an unknown product id", () => {
  const result = priceOrder([oil], [{ productId: "ghost", quantity: 1 }], freeShipping);
  assert.ok(!result.ok);
  assert.equal(result.problem.kind, "product-not-found");
});

test("rejects an inactive product even when the id exists and stock is available", () => {
  const result = priceOrder([inactive], [{ productId: "p-old", quantity: 1 }], freeShipping);
  assert.ok(!result.ok);
  assert.equal(result.problem.kind, "product-inactive");
});

test("rejects a quantity above available stock", () => {
  const result = priceOrder([honey], [{ productId: "p-honey", quantity: 3 }], freeShipping);
  assert.ok(!result.ok);
  assert.equal(result.problem.kind, "insufficient-stock");
  if (result.problem.kind === "insufficient-stock") {
    assert.equal(result.problem.available, 2);
    assert.equal(result.problem.requested, 3);
  }
});

test("accepts a quantity exactly equal to stock", () => {
  const result = priceOrder([honey], [{ productId: "p-honey", quantity: 2 }], freeShipping);
  assert.ok(result.ok);
  assert.equal(result.totalPaise, 76000);
});

// The reason this module is pure: a client could otherwise name its own price.
test("ignores any price supplied by the caller - only the product's price is used", () => {
  const sneaky = [
    { productId: "p-oil", quantity: 1, unitPrice: 1, total: 1, price: 1 },
  ] as unknown as { productId: string; quantity: number }[];
  const result = priceOrder([oil], sneaky, freeShipping);
  assert.ok(result.ok);
  assert.equal(result.totalPaise, 45000); // the database price, not the injected 1 paise
});

test("rejects zero, negative and fractional quantities", () => {
  for (const quantity of [0, -1, 1.5, NaN]) {
    const result = priceOrder([oil], [{ productId: "p-oil", quantity }], freeShipping);
    assert.ok(!result.ok, `quantity ${quantity} should be rejected`);
    assert.equal(result.problem.kind, "invalid-quantity");
  }
});

test("does not mutate the products or requested lines it is given", () => {
  const products = [oil, honey];
  const requested = [{ productId: "p-oil", quantity: 1 }];
  const productsCopy = structuredClone(products);
  const requestedCopy = structuredClone(requested);

  priceOrder(products, requested, freeShipping);

  assert.deepEqual(products, productsCopy);
  assert.deepEqual(requested, requestedCopy);
});
