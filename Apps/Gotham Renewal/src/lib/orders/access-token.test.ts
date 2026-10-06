/**
 * Order access token tests.
 *
 * This is an authorisation control, so the attacks are the test cases: no token,
 * a token for a different order, a forged signature, and an expired link.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ORDER_ACCESS_TTL_MS,
  createOrderAccessToken,
  verifyOrderAccessToken,
} from "./access-token";

const SECRET = "a-test-secret-that-is-at-least-32-bytes-long";
const ORDER_A = "11111111-1111-4111-8111-111111111111";
const ORDER_B = "22222222-2222-4222-8222-222222222222";

test("a fresh token authorises its own order", () => {
  const token = createOrderAccessToken(ORDER_A, SECRET);
  assert.ok(verifyOrderAccessToken(ORDER_A, token, SECRET));
});

test("a token for one order does NOT authorise another", () => {
  const token = createOrderAccessToken(ORDER_A, SECRET);
  assert.ok(!verifyOrderAccessToken(ORDER_B, token, SECRET));
});

test("no token is refused", () => {
  for (const missing of [undefined, null, ""]) {
    assert.ok(!verifyOrderAccessToken(ORDER_A, missing, SECRET));
  }
});

test("a token signed with a different secret is refused", () => {
  const token = createOrderAccessToken(ORDER_A, SECRET);
  assert.ok(!verifyOrderAccessToken(ORDER_A, token, "a-different-secret-value-entirely"));
});

test("an expired token is refused", () => {
  const past = Date.now() - ORDER_ACCESS_TTL_MS - 1000;
  const token = createOrderAccessToken(ORDER_A, SECRET, ORDER_ACCESS_TTL_MS, past);
  assert.ok(!verifyOrderAccessToken(ORDER_A, token, SECRET));
});

test("a token is valid up to its expiry, not after", () => {
  const now = Date.now();
  const token = createOrderAccessToken(ORDER_A, SECRET, 1000, now);
  assert.ok(verifyOrderAccessToken(ORDER_A, token, SECRET, now + 999));
  assert.ok(!verifyOrderAccessToken(ORDER_A, token, SECRET, now + 1001));
});

test("an attacker cannot extend the expiry by editing the timestamp", () => {
  const token = createOrderAccessToken(ORDER_A, SECRET, 1000);
  const [, signature] = token.split(".");
  const forged = `${Date.now() + ORDER_ACCESS_TTL_MS * 100}.${signature}`;
  assert.ok(!verifyOrderAccessToken(ORDER_A, forged, SECRET));
});

test("malformed tokens are refused without throwing", () => {
  for (const bad of ["", ".", "no-dot", "abc.", ".def", "NaN.abc", "12.34"]) {
    assert.doesNotThrow(() => verifyOrderAccessToken(ORDER_A, bad, SECRET), `threw on ${bad}`);
    assert.ok(!verifyOrderAccessToken(ORDER_A, bad, SECRET), `accepted ${bad}`);
  }
});

test("two tokens for the same order differ over time (fresh expiry each mint)", () => {
  const first = createOrderAccessToken(ORDER_A, SECRET, ORDER_ACCESS_TTL_MS, Date.now());
  const second = createOrderAccessToken(ORDER_A, SECRET, ORDER_ACCESS_TTL_MS, Date.now() + 5000);
  assert.notEqual(first, second);
});
