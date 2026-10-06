/**
 * Rate-limit behaviour tests.
 *
 * These run against the IN-MEMORY backend (no Upstash credentials in the test
 * environment), which is the same code path local development uses. What is
 * asserted is the contract callers depend on: a bucket allows up to its limit,
 * refuses beyond it, reports a sensible retry, and scopes by key AND caller so
 * two endpoints or two IPs never share a budget.
 *
 * NOTE: `rate-limit.ts` is `server-only`, so these run under the
 * `react-server` condition (`npm test` sets it) where that import is a no-op.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rateLimit, resetRateLimits } from "./rate-limit";

function requestWithIp(ip: string): Request {
  return new Request("https://example.test/x", { headers: { "x-forwarded-for": ip } });
}

beforeEach(() => {
  resetRateLimits();
});

test("allows exactly the limit, then refuses", async () => {
  const options = { key: "test-basic", limit: 3, windowMs: 60_000 };

  for (let i = 1; i <= 3; i++) {
    const result = await rateLimit(requestWithIp("1.1.1.1"), options);
    assert.equal(result.ok, true, `request ${i} should be allowed`);
  }

  const fourth = await rateLimit(requestWithIp("1.1.1.1"), options);
  assert.equal(fourth.ok, false, "the fourth should be refused");
  if (!fourth.ok) {
    assert.ok(fourth.retryAfterSeconds >= 1, "a retry delay is reported");
  }
});

test("one caller's traffic does not consume another's budget", async () => {
  const options = { key: "test-per-ip", limit: 1, windowMs: 60_000 };

  assert.equal((await rateLimit(requestWithIp("2.2.2.2"), options)).ok, true);
  assert.equal(
    (await rateLimit(requestWithIp("2.2.2.2"), options)).ok,
    false,
    "the same caller is limited",
  );
  assert.equal(
    (await rateLimit(requestWithIp("3.3.3.3"), options)).ok,
    true,
    "a different caller has their own budget",
  );
});

test("two endpoints do not share a bucket", async () => {
  const a = { key: "test-endpoint-a", limit: 1, windowMs: 60_000 };
  const b = { key: "test-endpoint-b", limit: 1, windowMs: 60_000 };

  assert.equal((await rateLimit(requestWithIp("4.4.4.4"), a)).ok, true);
  assert.equal((await rateLimit(requestWithIp("4.4.4.4"), a)).ok, false);
  assert.equal(
    (await rateLimit(requestWithIp("4.4.4.4"), b)).ok,
    true,
    "a different endpoint has its own bucket",
  );
});

test("a window expiry resets the bucket", async () => {
  // A 1ms window is effectively always expired, so the next request starts fresh.
  const options = { key: "test-window", limit: 1, windowMs: 1 };
  assert.equal((await rateLimit(requestWithIp("5.5.5.5"), options)).ok, true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await rateLimit(requestWithIp("5.5.5.5"), options)).ok, true, "the window reset");
});

test("a request with no IP header is bucketed, not waved through", async () => {
  const options = { key: "test-no-ip", limit: 1, windowMs: 60_000 };
  const noHeaders = new Request("https://example.test/x");

  assert.equal((await rateLimit(noHeaders, options)).ok, true);
  assert.equal(
    (await rateLimit(noHeaders, options)).ok,
    false,
    "an unidentified caller is still limited (shared bucket), never unlimited",
  );
});

test("the left-most x-forwarded-for entry is used as the client", async () => {
  const options = { key: "test-xff", limit: 1, windowMs: 60_000 };
  const chained = new Request("https://example.test/x", {
    headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1, 10.0.0.2" },
  });

  assert.equal((await rateLimit(chained, options)).ok, true);
  assert.equal((await rateLimit(chained, options)).ok, false);
  // A different original client, behind the same proxies, gets its own budget.
  const other = new Request("https://example.test/x", {
    headers: { "x-forwarded-for": "8.8.8.8, 10.0.0.1, 10.0.0.2" },
  });
  assert.equal((await rateLimit(other, options)).ok, true);
});
