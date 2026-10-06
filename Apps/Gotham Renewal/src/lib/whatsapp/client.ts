/**
 * WhatsApp Cloud API transport.
 *
 * This file owns the endpoint, auth, timeout, and error normalisation - and
 * nothing else. It knows nothing about orders or templates. It never retries:
 * the API has no idempotency key, so a retry can double-send. The caller
 * decides using `retryable` on the returned error.
 *
 * Expected API failures are RETURNED, not thrown, so the service can record
 * FAILED and retry later without a try/catch around every call. Only
 * programming errors (a bug in our own code) should throw.
 *
 * Environment-agnostic on purpose: config is an explicit parameter, so this
 * module has no `@/lib/env` dependency and can be unit-tested with a stubbed
 * fetch.
 */
import type {
  SendOptions,
  SendTemplateInput,
  SendTextInput,
  TemplateParameter,
  WhatsAppConfig,
  WhatsAppError,
  WhatsAppSendResult,
} from "./types";
import { logger } from "@/lib/logger";

const GRAPH_BASE_URL = "https://graph.facebook.com";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Graph error codes worth retrying with backoff, per
 * docs/research/whatsapp-cloud-api.md §6. Everything else is permanent:
 * retrying an invalid token or a bad payload makes it worse.
 */
const RETRYABLE_CODES = new Set<number>([
  1, 2, 130429, 131000, 131016, 131048, 131057, 133004, 80007,
]);

/** Coerce a Graph code (sometimes a string) to a number; undefined if absent. */
function normalizeCode(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  return undefined;
}

/**
 * Turn a non-2xx Graph response into a normalised error. Tolerates a
 * malformed/empty body: with no `code` we fall back to the HTTP status
 * (429 and 5xx are retryable, everything else is not).
 */
export function toGraphError(httpStatus: number, raw: unknown): WhatsAppError {
  const envelope = (raw as { error?: Record<string, unknown> } | undefined)?.error;
  const code = normalizeCode(envelope?.code);
  const errorData = envelope?.error_data as { details?: unknown } | undefined;

  return {
    ok: false,
    kind: "api",
    httpStatus,
    code,
    details: typeof errorData?.details === "string" ? errorData.details : undefined,
    message:
      typeof envelope?.message === "string"
        ? envelope.message
        : "Unknown WhatsApp API error",
    fbtraceId:
      typeof envelope?.fbtrace_id === "string" ? envelope.fbtrace_id : undefined,
    retryable:
      code !== undefined
        ? RETRYABLE_CODES.has(code)
        : httpStatus === 429 || httpStatus >= 500,
  };
}

/**
 * Log a failure without the token. Synchronous, so a log line is never dropped
 * when the process exits right after a send - which is exactly when it matters.
 */
function logFailure(error: WhatsAppError): void {
  const fields = {
    kind: error.kind,
    httpStatus: error.httpStatus,
    code: error.code,
    details: error.details,
    fbtraceId: error.fbtraceId,
    retryable: error.retryable,
  };
  if (error.retryable) logger.warn("whatsapp send failed (retryable)", fields);
  else logger.error("whatsapp send failed", fields);
}

function messagesUrl(config: WhatsAppConfig): string {
  return `${GRAPH_BASE_URL}/${config.graphVersion}/${config.phoneNumberId}/messages`;
}

/** POST a message body, return `{ messageId }` or a typed error. Never throws. */
async function postMessage(
  config: WhatsAppConfig,
  body: unknown,
  options: SendOptions = {},
): Promise<WhatsAppSendResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let response: Response;
  let raw: string;
  try {
    response = await fetch(messagesUrl(config), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    raw = await response.text();
  } catch (thrown) {
    // No response: timeout or network failure. The message may or may not have
    // been accepted - the caller decides, per §7. Retryable, conservatively.
    const timedOut =
      thrown instanceof Error &&
      (thrown.name === "TimeoutError" || thrown.name === "AbortError");
    const error: WhatsAppError = {
      ok: false,
      kind: timedOut ? "timeout" : "network",
      message: timedOut
        ? `WhatsApp request timed out after ${timeoutMs}ms`
        : thrown instanceof Error
          ? thrown.message
          : "WhatsApp request failed",
      retryable: true,
    };
    logFailure(error);
    return error;
  }

  let parsed: unknown;
  try {
    parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined; // Malformed body: classified below, never thrown.
  }

  if (!response.ok) {
    const error = toGraphError(response.status, parsed);
    logFailure(error);
    return error;
  }

  const messageId = (parsed as { messages?: Array<{ id?: unknown }> } | undefined)
    ?.messages?.[0]?.id;
  if (typeof messageId !== "string" || messageId.length === 0) {
    const error: WhatsAppError = {
      ok: false,
      kind: "api",
      httpStatus: response.status,
      message: "WhatsApp accepted the request but returned no message id",
      retryable: false,
    };
    logFailure(error);
    return error;
  }

  return { ok: true, messageId };
}

/** Build the `components` array for a template send from the shaping layer. */
function buildComponents(
  input: SendTemplateInput,
): Array<Record<string, unknown>> {
  const components: Array<Record<string, unknown>> = [];

  if (input.headerParameters && input.headerParameters.length > 0) {
    components.push({ type: "header", parameters: input.headerParameters });
  }

  components.push({ type: "body", parameters: input.bodyParameters });

  if (input.buttonUrlParameters && input.buttonUrlParameters.length > 0) {
    input.buttonUrlParameters.forEach((suffix, index) => {
      components.push({
        type: "button",
        sub_type: "url",
        index: String(index),
        parameters: [{ type: "text", text: suffix }],
      });
    });
  }

  return components;
}

/**
 * Send an approved template. This is the only legal way to initiate a
 * conversation outside the 24-hour customer service window, so the business
 * owner alert uses it.
 */
export async function sendTemplateMessage(
  config: WhatsAppConfig,
  input: SendTemplateInput,
  options?: SendOptions,
): Promise<WhatsAppSendResult> {
  return postMessage(
    config,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: "template",
      template: {
        name: input.templateName,
        language: { code: input.languageCode },
        components: buildComponents(input),
      },
    },
    options,
  );
}

/**
 * Send free-form text. ONLY legal inside an open 24-hour customer service
 * window (a Customer Notification replying to a customer who messaged us).
 * Outside the window Meta rejects it with error `131047`.
 */
export async function sendTextMessage(
  config: WhatsAppConfig,
  input: SendTextInput,
  options?: SendOptions,
): Promise<WhatsAppSendResult> {
  return postMessage(
    config,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: "text",
      text: { preview_url: input.previewUrl ?? false, body: input.body },
    },
    options,
  );
}

export type { TemplateParameter };
