/**
 * Password hashing tests.
 *
 * These matter because a hashing bug is silent: logins still "work" in the
 * happy path while the hash is worthless (no salt, truncated key, a comparison
 * that accepts anything).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, safeEqual, verifyPassword } from "./password";

test("a correct password verifies", () => {
  const stored = hashPassword("correct horse battery staple");
  assert.ok(verifyPassword("correct horse battery staple", stored));
});

test("a wrong password does not verify", () => {
  const stored = hashPassword("correct horse battery staple");
  assert.ok(!verifyPassword("correct horse battery stapl", stored));
  assert.ok(!verifyPassword("", stored));
  assert.ok(!verifyPassword("Correct Horse Battery Staple", stored));
});

test("the same password hashes differently each time (unique salt)", () => {
  const a = hashPassword("same-password");
  const b = hashPassword("same-password");
  assert.notEqual(a, b, "two hashes of one password must differ");
  assert.ok(verifyPassword("same-password", a));
  assert.ok(verifyPassword("same-password", b));
});

test("the stored hash reveals no plaintext and follows the documented format", () => {
  const stored = hashPassword("hunter2");
  assert.ok(!stored.includes("hunter2"));
  const parts = stored.split("$");
  assert.equal(parts.length, 6);
  assert.equal(parts[0], "scrypt");
  assert.equal(Number(parts[1]), 2 ** 15);
});

test("verification does not throw on malformed or hostile stored values", () => {
  for (const bad of [
    "",
    "not-a-hash",
    "scrypt$1$2$3",
    "scrypt$x$y$z$aa$bb",
    "bcrypt$16384$8$1$aa$bb",
    "scrypt$16384$8$1$$",
    "$$$$$",
  ]) {
    assert.doesNotThrow(() => verifyPassword("anything", bad), `threw on ${JSON.stringify(bad)}`);
    assert.equal(verifyPassword("anything", bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

test("safeEqual compares without leaking through a length mismatch", () => {
  assert.ok(safeEqual("abc", "abc"));
  assert.ok(!safeEqual("abc", "abd"));
  assert.ok(!safeEqual("abc", "abcd"));
  assert.ok(!safeEqual("", "a"));
  assert.ok(safeEqual("", ""));
});

test("unicode passwords round-trip", () => {
  const password = "अच्छा-पासवर्ड-🔐";
  const stored = hashPassword(password);
  assert.ok(verifyPassword(password, stored));
  assert.ok(!verifyPassword("अच्छा-पासवर्ड", stored));
});
