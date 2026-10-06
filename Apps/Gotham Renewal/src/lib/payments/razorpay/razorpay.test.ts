/**
 * Razorpay payment layer tests.
 *
 * Node's built-in test runner, matching `src/lib/money.test.ts`. No real
 * network: `globalThis.fetch` is stubbed and restored. The signature tests are
 * the important ones - they generate a real HMAC with a known secret.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createRazorpayOrder, fetchPayment } from "./client";
import {
  deriveEventKey,
  parseWebhookEvent,
  verifyWebhookSignature,
  verifyWebhook,
} from "./webhook";
import type { RazorpayConfig } from "./types";

const config: RazorpayConfig = {
  keyId: "rzp_test_abc123",
  keySecret: "super_secret_key",
  webhookSecret: "whsec_test_secret",
  baseUrl: "https://api.example.test",
};

const WEBHOOK_SECRET = "whsec_test_secret";

function sign(body: string, secret = WEBHOOK_SECRET): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

const CAPTURED_BODY = JSON.stringify({
  entity: "event",
  account_id: "acc_123",
  event: "payment.captured",
  contains: ["payment"],
  payload: {
    payment: {
      entity: {
        id: "pay_ABC123",
        entity: "payment",
        amount: 248050,
        currency: "INR",
        status: "captured",
        order_id: "order_XYZ789",
        captured: true,
      },
    },
  },
  created_at: 1_700_000_000,
});

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

test("verifyWebhookSignature accepts a correct signature", () => {
  const signature = sign(CAPTURED_BODY);
  assert.deepEqual(verifyWebhookSignature(CAPTURED_BODY, signature, WEBHOOK_SECRET), { ok: true });
});

test("verifyWebhookSignature rejects a wrong signature", () => {
  const signature = sign(CAPTURED_BODY, "the_wrong_secret");
  assert.deepEqual(verifyWebhookSignature(CAPTURED_BODY, signature, WEBHOOK_SECRET), {
    ok: false,
    reason: "invalid-signature",
  });
});

test("verifyWebhookSignature rejects a missing signature header", () => {
  assert.deepEqual(verifyWebhookSignature(CAPTURED_BODY, null, WEBHOOK_SECRET), {
    ok: false,
    reason: "missing-signature",
  });
  assert.deepEqual(verifyWebhookSignature(CAPTURED_BODY, "", WEBHOOK_SECRET), {
    ok: false,
    reason: "missing-signature",
  });
});

test("verifyWebhookSignature rejects a missing secret", () => {
  assert.deepEqual(verifyWebhookSignature(CAPTURED_BODY, sign(CAPTURED_BODY), ""), {
    ok: false,
    reason: "missing-secret",
  });
});

test("verifyWebhookSignature rejects a body tampered with after signing", () => {
  const signature = sign(CAPTURED_BODY);
  // Same event, amount changed - proves raw-body integrity is what is signed.
  const tampered = CAPTURED_BODY.replace("248050", "000001");
  assert.notEqual(tampered, CAPTURED_BODY);
  assert.deepEqual(verifyWebhookSignature(tampered, signature, WEBHOOK_SECRET), {
    ok: false,
    reason: "invalid-signature",
  });
});

test("verifyWebhookSignature does not throw on a wrong-length signature", () => {
  // timingSafeEqual throws on length mismatch; the guard must prevent that.
  assert.doesNotThrow(() => verifyWebhookSignature(CAPTURED_BODY, "deadbeef", WEBHOOK_SECRET));
  assert.deepEqual(verifyWebhookSignature(CAPTURED_BODY, "deadbeef", WEBHOOK_SECRET), {
    ok: false,
    reason: "length-mismatch",
  });
});

test("verifyWebhook reads the signature from headers", () => {
  const headers = new Headers({ "x-razorpay-signature": sign(CAPTURED_BODY) });
  assert.deepEqual(verifyWebhook(CAPTURED_BODY, headers, WEBHOOK_SECRET), { ok: true });
  assert.deepEqual(verifyWebhook(CAPTURED_BODY, new Headers(), WEBHOOK_SECRET), {
    ok: false,
    reason: "missing-signature",
  });
});

// ---------------------------------------------------------------------------
// parseWebhookEvent
// ---------------------------------------------------------------------------

test("parseWebhookEvent extracts ids from a payment.captured payload", () => {
  const parsed = parseWebhookEvent(CAPTURED_BODY);
  assert.equal(parsed.event, "payment.captured");
  assert.equal(parsed.paymentId, "pay_ABC123");
  assert.equal(parsed.orderId, "order_XYZ789");
  assert.equal(parsed.amountPaise, 248050);
  assert.equal(parsed.currency, "INR");
  assert.equal(parsed.status, "captured");
});

test("parseWebhookEvent reads order.paid, which has both entities", () => {
  const body = JSON.stringify({
    event: "order.paid",
    payload: {
      order: { entity: { id: "order_XYZ789", amount: 248050, currency: "INR", status: "paid", receipt: "GR-1042" } },
      payment: { entity: { id: "pay_ABC123", order_id: "order_XYZ789", amount: 248050, currency: "INR", status: "captured" } },
    },
  });
  const parsed = parseWebhookEvent(body);
  assert.equal(parsed.event, "order.paid");
  assert.equal(parsed.orderId, "order_XYZ789");
  assert.equal(parsed.paymentId, "pay_ABC123");
  assert.equal(parsed.receipt, "GR-1042");
});

test("parseWebhookEvent does not crash on unexpected shapes", () => {
  assert.doesNotThrow(() => parseWebhookEvent("not json at all"));
  assert.deepEqual(parseWebhookEvent("not json at all"), {
    event: "",
    paymentId: null,
    orderId: null,
    amountPaise: null,
    currency: null,
    status: null,
    receipt: null,
  });

  const weird = parseWebhookEvent(JSON.stringify({ event: "payment.failed", payload: "nope" }));
  assert.equal(weird.event, "payment.failed");
  assert.equal(weird.paymentId, null);
  assert.equal(weird.orderId, null);

  assert.doesNotThrow(() => parseWebhookEvent(JSON.stringify(null)));
  assert.doesNotThrow(() => parseWebhookEvent(JSON.stringify([1, 2, 3])));
});

// ---------------------------------------------------------------------------
// deriveEventKey
// ---------------------------------------------------------------------------

test("deriveEventKey prefers the x-razorpay-event-id header", () => {
  const headers = new Headers({ "x-razorpay-event-id": "evt_unique_1" });
  assert.equal(deriveEventKey(headers, CAPTURED_BODY), "evt_unique_1");
});

test("deriveEventKey falls back to a stable body hash", () => {
  const key = deriveEventKey(new Headers(), CAPTURED_BODY);
  const expected = crypto.createHash("sha256").update(CAPTURED_BODY, "utf8").digest("hex");
  assert.equal(key, expected);
  // Same bytes -> same key (retry dedupes); different bytes -> different key.
  assert.equal(deriveEventKey(new Headers(), CAPTURED_BODY), key);
  assert.notEqual(deriveEventKey(new Headers(), CAPTURED_BODY + " "), key);
});

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

type FetchCall = { url: string; init: RequestInit };

function stubFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

test("createRazorpayOrder sends the right URL, auth, and body", async () => {
  const stub = stubFetch(() =>
    Response.json(
      {
        id: "order_XYZ789",
        entity: "order",
        amount: 248050,
        currency: "INR",
        receipt: "GR-1042",
        status: "created",
      },
      { status: 200 },
    ),
  );
  try {
    const result = await createRazorpayOrder(config, {
      amountPaise: 248050,
      receipt: "GR-1042",
      notes: { local_order_id: "ord_1", order_number: "GR-1042" },
    });

    assert.equal(stub.calls.length, 1);
    const { url, init } = stub.calls[0];
    assert.equal(url, "https://api.example.test/v1/orders");
    assert.equal(init.method, "POST");

    const expectedAuth = `Basic ${Buffer.from("rzp_test_abc123:super_secret_key").toString("base64")}`;
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, expectedAuth);
    assert.equal(headers["Content-Type"], "application/json");

    assert.deepEqual(JSON.parse(init.body as string), {
      amount: 248050,
      currency: "INR",
      receipt: "GR-1042",
      notes: { local_order_id: "ord_1", order_number: "GR-1042" },
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.order.id, "order_XYZ789");
    assert.equal(result.ok && result.order.amount, 248050);
  } finally {
    stub.restore();
  }
});

test("createRazorpayOrder rejects a non-integer amount before calling the API", async () => {
  const stub = stubFetch(() => Response.json({}, { status: 200 }));
  try {
    const result = await createRazorpayOrder(config, { amountPaise: 100.5, receipt: "GR-1" });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "INVALID_AMOUNT");
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("createRazorpayOrder returns a typed error on a non-2xx response", async () => {
  const stub = stubFetch(() =>
    Response.json(
      { error: { code: "BAD_REQUEST_ERROR", description: "The amount must be at least INR 1.00" } },
      { status: 400 },
    ),
  );
  try {
    const result = await createRazorpayOrder(config, { amountPaise: 50, receipt: "GR-1" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.ok === false ? result.error : null, {
      code: "BAD_REQUEST_ERROR",
      description: "The amount must be at least INR 1.00",
      status: 400,
    });
  } finally {
    stub.restore();
  }
});

test("createRazorpayOrder returns a NETWORK_ERROR when fetch rejects", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    const result = await createRazorpayOrder(config, { amountPaise: 100, receipt: "GR-1" });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "NETWORK_ERROR");
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchPayment GETs the payment and maps the entity", async () => {
  const stub = stubFetch(() =>
    Response.json(
      { id: "pay_ABC123", order_id: "order_XYZ789", amount: 248050, currency: "INR", status: "captured" },
      { status: 200 },
    ),
  );
  try {
    const result = await fetchPayment(config, "pay_ABC123");
    assert.equal(stub.calls[0].url, "https://api.example.test/v1/payments/pay_ABC123");
    assert.equal(stub.calls[0].init.method, "GET");
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.payment.orderId, "order_XYZ789");
  } finally {
    stub.restore();
  }
});
