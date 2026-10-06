/**
 * Session token tests.
 *
 * The token is the only thing standing between the public internet and the
 * admin dashboard, so these test the attacks: a forged signature, a payload
 * swapped after signing, and an expired token.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_TTL_MS,
  createSessionToken,
  verifySessionToken,
} from "./session";

const SECRET = "a-test-secret-that-is-at-least-32-bytes-long";

test("a freshly minted token verifies and carries its subject", () => {
  const token = createSessionToken(SECRET);
  const result = verifySessionToken(token, SECRET);
  assert.ok(result.ok);
  assert.equal(result.payload.sub, "admin");
});

test("a token signed with a different secret is rejected", () => {
  const token = createSessionToken(SECRET);
  const result = verifySessionToken(token, "a-completely-different-secret-value");
  assert.ok(!result.ok);
  assert.equal(result.reason, "bad-signature");
});

test("tampering with the payload invalidates the signature", () => {
  const token = createSessionToken(SECRET);
  const [encoded, signature] = token.split(".");

  // Re-encode a payload with a far-future expiry, keeping the old signature.
  const forged = Buffer.from(
    JSON.stringify({ sub: "admin", exp: Date.now() + SESSION_TTL_MS * 100 }),
  ).toString("base64url");
  const result = verifySessionToken(`${forged}.${signature}`, SECRET);

  assert.ok(!result.ok, "a re-signed-by-attacker payload must not verify");
  assert.equal(result.reason, "bad-signature");
  assert.notEqual(forged, encoded);
});

test("an expired token is rejected even though the signature is valid", () => {
  const past = Date.now() - SESSION_TTL_MS - 1000;
  const token = createSessionToken(SECRET, "admin", SESSION_TTL_MS, past);
  const result = verifySessionToken(token, SECRET);
  assert.ok(!result.ok);
  assert.equal(result.reason, "expired");
});

test("a token is accepted right up to its expiry and not a moment after", () => {
  const now = Date.now();
  const token = createSessionToken(SECRET, "admin", 1000, now);
  assert.ok(verifySessionToken(token, SECRET, now + 999).ok);
  assert.ok(!verifySessionToken(token, SECRET, now + 1001).ok);
});

test("malformed tokens are rejected without throwing", () => {
  for (const bad of [undefined, null, "", "no-dot", ".", "a.", ".b", "not.base64.at.all"]) {
    assert.doesNotThrow(() => verifySessionToken(bad, SECRET), `threw on ${String(bad)}`);
    assert.ok(!verifySessionToken(bad, SECRET).ok, `accepted ${String(bad)}`);
  }
});

test("a token cannot be verified with an empty secret", () => {
  const token = createSessionToken(SECRET);
  const result = verifySessionToken(token, "");
  assert.ok(!result.ok);
});
