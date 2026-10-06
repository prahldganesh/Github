/**
 * Money helper tests.
 *
 * Run with `npm test` (Node's built-in test runner via tsx - no test framework
 * dependency). Phase 15 grows this into the full suite; for now it covers the
 * arithmetic that authoritative payment calculations will depend on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rupeesToPaise, formatPaise, sumPaise, lineTotalPaise } from "./money";

test("rupeesToPaise rounds to the nearest paise", () => {
  assert.equal(rupeesToPaise(2480.5), 248050);
  assert.equal(rupeesToPaise(0.01), 1);
  assert.equal(rupeesToPaise(0.005), 1); // half-up
  assert.equal(rupeesToPaise(99.999), 10000);
});

test("integer paise avoid float drift that rupees would introduce", () => {
  // The classic failure: 0.1 + 0.2 !== 0.3 in binary floating point.
  const asPaise = sumPaise([rupeesToPaise(0.1), rupeesToPaise(0.2)]);
  assert.equal(asPaise, 30);
  assert.notEqual(0.1 + 0.2, 0.3); // demonstrates the hazard being avoided
});

test("lineTotalPaise multiplies exactly", () => {
  assert.equal(lineTotalPaise(248050, 3), 744150);
  assert.equal(lineTotalPaise(0, 5), 0);
});

test("lineTotalPaise rejects nonsense quantities", () => {
  assert.throws(() => lineTotalPaise(100, 0), /positive integer/);
  assert.throws(() => lineTotalPaise(100, -1), /positive integer/);
  assert.throws(() => lineTotalPaise(100, 1.5), /positive integer/);
});

test("formatPaise renders Indian currency", () => {
  // Non-breaking spaces vary by ICU build; assert the digits and symbol.
  const formatted = formatPaise(248050);
  assert.match(formatted, /₹/);
  assert.match(formatted, /2,?480\.50/);
});
