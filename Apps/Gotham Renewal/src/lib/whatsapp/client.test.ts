/**
 * WhatsApp client + template-shaping tests.
 *
 * Run with `npm test` (Node's built-in runner via tsx). No network: `fetch` is
 * stubbed and restored for every test. Throwing on an expected API failure
 * would be a bug here, so several tests assert the error is RETURNED.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sendTemplateMessage, sendTextMessage } from "./client";
import {
  NEW_ORDER_ALERT,
  newOrderAlertParameters,
  orderStatusUpdateParameters,
} from "./templates";
import type { TemplateParameter, WhatsAppConfig } from "./types";

const CONFIG: WhatsAppConfig = {
  phoneNumberId: "106540352242922",
  accessToken: "EAAG-secret-token-value",
  graphVersion: "v21.0",
};

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string; signal?: unknown };

/** Run `fn` with `globalThis.fetch` replaced by `stub`, then restore it. */
async function withFetch(
  stub: (url: string, init: FetchInit) => Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init: FetchInit) =>
    stub(url, init)) as unknown as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** Minimal stand-in for a fetch Response, enough for the client. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const BODY_PARAMS: TemplateParameter[] = [
  { type: "text", parameter_name: "order_number", text: "GR-1042" },
];

test("successful send returns the message id from messages[0].id", async () => {
  await withFetch(
    async () =>
      jsonResponse(200, {
        messaging_product: "whatsapp",
        contacts: [{ input: "919876543210", wa_id: "919876543210" }],
        messages: [{ id: "wamid.HBgLMTY0NjcwNDM1OTU" }],
      }),
    async () => {
      const result = await sendTemplateMessage(CONFIG, {
        to: "919876543210",
        templateName: NEW_ORDER_ALERT.name,
        languageCode: NEW_ORDER_ALERT.languageCode,
        bodyParameters: BODY_PARAMS,
      });
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.messageId, "wamid.HBgLMTY0NjcwNDM1OTU");
    },
  );
});

test("the request goes to the right URL with Bearer auth and JSON", async () => {
  let captured: { url: string; init: FetchInit } | undefined;
  await withFetch(
    async (url, init) => {
      captured = { url, init };
      return jsonResponse(200, { messages: [{ id: "wamid.abc" }] });
    },
    async () => {
      await sendTemplateMessage(CONFIG, {
        to: "919876543210",
        templateName: NEW_ORDER_ALERT.name,
        languageCode: NEW_ORDER_ALERT.languageCode,
        bodyParameters: BODY_PARAMS,
      });
    },
  );

  assert.equal(
    captured?.url,
    "https://graph.facebook.com/v21.0/106540352242922/messages",
  );
  assert.equal(captured?.init.method, "POST");
  assert.equal(captured?.init.headers?.Authorization, "Bearer EAAG-secret-token-value");
  assert.equal(captured?.init.headers?.["Content-Type"], "application/json");
  assert.ok(captured?.init.signal, "a timeout signal is attached");
});

test("the payload is a correct named template message", async () => {
  let body: Record<string, unknown> | undefined;
  await withFetch(
    async (_url, init) => {
      body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      return jsonResponse(200, { messages: [{ id: "wamid.abc" }] });
    },
    async () => {
      await sendTemplateMessage(CONFIG, {
        to: "919876543210",
        templateName: NEW_ORDER_ALERT.name,
        languageCode: NEW_ORDER_ALERT.languageCode,
        bodyParameters: BODY_PARAMS,
      });
    },
  );

  assert.equal(body?.messaging_product, "whatsapp");
  assert.equal(body?.type, "template");
  const template = body?.template as {
    name: string;
    language: { code: string };
    components: Array<{ type: string; parameters: TemplateParameter[] }>;
  };
  assert.equal(template.name, "new_order_alert");
  assert.equal(template.language.code, "en_IN");
  assert.equal(template.components[0].type, "body");
  assert.equal(template.components[0].parameters[0].parameter_name, "order_number");
});

test("a 130429 rate-limit response is classified retryable", async () => {
  await withFetch(
    async () =>
      jsonResponse(429, {
        error: {
          message: "(#130429) Rate limit hit",
          type: "OAuthException",
          code: 130429,
          error_data: { details: "Cloud API message throughput has been reached." },
          fbtrace_id: "Az8or2yhqkZfEZ-_4Qn_Bam",
        },
      }),
    async () => {
      const result = await sendTemplateMessage(CONFIG, {
        to: "919876543210",
        templateName: NEW_ORDER_ALERT.name,
        languageCode: NEW_ORDER_ALERT.languageCode,
        bodyParameters: BODY_PARAMS,
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.retryable, true);
        assert.equal(result.code, 130429);
        assert.equal(result.fbtraceId, "Az8or2yhqkZfEZ-_4Qn_Bam");
      }
    },
  );
});

test("an 190 invalid-token response is NOT retryable", async () => {
  await withFetch(
    async () =>
      jsonResponse(401, {
        error: {
          message: "Error validating access token: Session has expired.",
          type: "OAuthException",
          code: 190,
          fbtrace_id: "AbCdEf123",
        },
      }),
    async () => {
      const result = await sendTemplateMessage(CONFIG, {
        to: "919876543210",
        templateName: NEW_ORDER_ALERT.name,
        languageCode: NEW_ORDER_ALERT.languageCode,
        bodyParameters: BODY_PARAMS,
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.retryable, false);
        assert.equal(result.code, 190);
      }
    },
  );
});

test("a malformed / non-JSON error body is handled without throwing", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: false,
    status: 502,
    text: async () => "<html>Bad Gateway</html>",
  })) as unknown as typeof fetch;
  try {
    const result = await sendTemplateMessage(CONFIG, {
      to: "919876543210",
      templateName: NEW_ORDER_ALERT.name,
      languageCode: NEW_ORDER_ALERT.languageCode,
      bodyParameters: BODY_PARAMS,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, undefined);
      assert.equal(result.retryable, true, "5xx with no body is treated as transient");
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("a no-message-id 2xx response is a permanent error, not a throw", async () => {
  await withFetch(
    async () => jsonResponse(200, { messaging_product: "whatsapp" }),
    async () => {
      const result = await sendTemplateMessage(CONFIG, {
        to: "919876543210",
        templateName: NEW_ORDER_ALERT.name,
        languageCode: NEW_ORDER_ALERT.languageCode,
        bodyParameters: BODY_PARAMS,
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.retryable, false);
    },
  );
});

test("sendTextMessage sends a text body for an in-window reply", async () => {
  let body: Record<string, unknown> | undefined;
  await withFetch(
    async (_url, init) => {
      body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      return jsonResponse(200, { messages: [{ id: "wamid.text" }] });
    },
    async () => {
      const result = await sendTextMessage(CONFIG, {
        to: "919876543210",
        body: "Your order is packed.",
        previewUrl: true,
      });
      assert.equal(result.ok, true);
    },
  );
  assert.equal(body?.type, "text");
  const text = body?.text as { body: string; preview_url: boolean };
  assert.equal(text.body, "Your order is packed.");
  assert.equal(text.preview_url, true);
});

test("newOrderAlertParameters maps fields and formats paise as a display amount", () => {
  const params = newOrderAlertParameters({
    orderNumber: "GR-1042",
    customerName: "Raj Kumar",
    totalPaise: 248050,
    paymentLabel: "PAID",
    orderUrl: "https://example.com/admin/orders/123",
  });

  assert.deepEqual(
    params.map((p) => p.parameter_name),
    ["order_number", "customer_name", "amount", "payment_status", "order_url"],
  );
  assert.equal(params[0].text, "GR-1042");
  assert.equal(params[1].text, "Raj Kumar");
  assert.equal(params[2].text, "₹2,480.50");
  assert.equal(params[3].text, "PAID");
  assert.ok(params.every((p) => p.type === "text"));
});

test("orderStatusUpdateParameters maps the status and note", () => {
  const params = orderStatusUpdateParameters({
    orderNumber: "GR-1042",
    status: "SHIPPED",
    note: "Tracking: XX123",
  });
  assert.deepEqual(
    params.map((p) => [p.parameter_name, p.text]),
    [
      ["order_number", "GR-1042"],
      ["status", "SHIPPED"],
      ["note", "Tracking: XX123"],
    ],
  );
});
