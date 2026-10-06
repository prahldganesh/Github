/**
 * Cart store tests.
 *
 * The store is pure, so these run under plain Node with no browser and no
 * React (see `npm test`). Phase 15 grows the suite; this covers the core
 * arithmetic and the no-mutation invariant the rest of the cart leans on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addLine,
  clearCart,
  countLines,
  getLine,
  removeLine,
  setQuantity,
  subtotalPaise,
} from "./store";
import type { Cart, CartLine } from "./types";

const chai: CartLine = { productId: "p1", slug: "chai", name: "Chai", unitPrice: 15000, quantity: 1 };
const coffee: CartLine = { productId: "p2", slug: "coffee", name: "Coffee", unitPrice: 24050, quantity: 2 };

const base: Cart = { lines: [chai, coffee] };

test("addLine adds a new product as a line", () => {
  const cart = addLine({ lines: [] }, chai);
  assert.equal(cart.lines.length, 1);
  assert.deepEqual(cart.lines[0], chai);
});

test("addLine increments quantity instead of duplicating an existing product", () => {
  const cart = addLine(base, { ...chai, quantity: 3 });
  assert.equal(cart.lines.length, 2);
  assert.equal(getLine(cart, "p1")?.quantity, 4);
});

test("setQuantity sets an existing line's quantity", () => {
  const cart = setQuantity(base, "p1", 5);
  assert.equal(getLine(cart, "p1")?.quantity, 5);
  assert.equal(getLine(cart, "p2")?.quantity, 2);
});

test("setQuantity to zero or negative removes the line", () => {
  assert.equal(getLine(setQuantity(base, "p1", 0), "p1"), undefined);
  assert.equal(getLine(setQuantity(base, "p1", -2), "p1"), undefined);
  assert.equal(setQuantity(base, "p1", 0).lines.length, 1);
});

// Regression: `addLine` used to admit any number as a quantity, so adding
// quantity 0 created a line with quantity 0, and `subtotalPaise` then THREW
// (via lineTotalPaise). Because the subtotal is computed inside the provider's
// useMemo, that would have crashed every page rendering the cart.
test("addLine rejects a non-positive quantity instead of creating a broken line", () => {
  assert.deepEqual(addLine({ lines: [] }, { ...chai, quantity: 0 }), { lines: [] });
  assert.deepEqual(addLine({ lines: [] }, { ...chai, quantity: -5 }), { lines: [] });
  // The invariant that `subtotalPaise` depends on must hold afterwards.
  assert.doesNotThrow(() => subtotalPaise(addLine({ lines: [] }, { ...chai, quantity: 0 })));
});

test("addLine floors a fractional quantity rather than storing it", () => {
  const cart = addLine({ lines: [] }, { ...chai, quantity: 1.9 });
  assert.equal(getLine(cart, "p1")?.quantity, 1);
  assert.doesNotThrow(() => subtotalPaise(cart));
});

test("addLine treats a non-finite quantity as zero", () => {
  assert.deepEqual(addLine({ lines: [] }, { ...chai, quantity: NaN }), { lines: [] });
  assert.deepEqual(addLine({ lines: [] }, { ...chai, quantity: Infinity }), { lines: [] });
});

test("setQuantity sanitises fractional and non-finite quantities", () => {
  assert.equal(getLine(setQuantity(base, "p1", 2.7), "p1")?.quantity, 2);
  assert.equal(getLine(setQuantity(base, "p1", NaN), "p1"), undefined);
  assert.doesNotThrow(() => subtotalPaise(setQuantity(base, "p1", 2.7)));
});

test("removeLine drops the matching line and leaves the rest", () => {
  const cart = removeLine(base, "p1");
  assert.equal(cart.lines.length, 1);
  assert.equal(cart.lines[0].productId, "p2");
});

test("removeLine ignores an unknown product id", () => {
  assert.deepEqual(removeLine(base, "nope"), base);
});

test("clearCart returns an empty cart", () => {
  assert.deepEqual(clearCart(), { lines: [] });
});

test("countLines sums quantities, not the number of lines", () => {
  assert.equal(countLines(base), 3); // 1 chai + 2 coffee
  assert.equal(countLines({ lines: [] }), 0);
});

test("subtotalPaise sums line totals across multiple lines and quantities", () => {
  // 1 x 15000 + 2 x 24050 = 15000 + 48100 = 63100
  assert.equal(subtotalPaise(base), 63100);
  assert.equal(subtotalPaise({ lines: [] }), 0);
});

test("store functions do not mutate the input cart", () => {
  const snapshot = structuredClone(base);

  addLine(base, { ...chai, quantity: 9 });
  setQuantity(base, "p1", 7);
  removeLine(base, "p1");
  clearCart();
  subtotalPaise(base);
  countLines(base);

  assert.deepEqual(base, snapshot);
  assert.equal(base.lines[0].quantity, 1);
  assert.equal(base.lines.length, 2);
});
