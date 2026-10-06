/**
 * Razorpay webhook verification - the security boundary.
 *
 * Kept separate from the REST client because this is the only place that must
 * get cryptography right, and the only place an untrusted caller reaches.
 *
 * Razorpay signs HMAC-SHA256(secret = RAZORPAY_WEBHOOK_SECRET, message = the
 * RAW request body bytes) and sends the hex digest in `X-Razorpay-Signature`.
 * Two rules matter:
 *   1. Sign the exact bytes received. Never `JSON.parse` then re-stringify -
 *      key order and whitespace change and the digest no longer matches.
 *   2. Compare in constant time (`crypto.timingSafeEqual`) with a length guard
 *      first, since `timingSafeEqual` throws on mismatched lengths.
 *
 * An invalid signature is a normal outcome, returned as `{ ok: false }`; this
 * module never throws for it.
 */
import crypto from "node:crypto";
import type { ParsedWebhookEvent, VerificationResult } from "./types";

/** The header Razorpay uses for the HMAC-SHA256 hex digest. */
export const SIGNATURE_HEADER = "x-razorpay-signature";
/** The header Razorpay uses for a per-event unique id, the best idempotency key. */
export const EVENT_ID_HEADER = "x-razorpay-event-id";

type HeaderSource = Headers | Record<string, string | undefined> | null | undefined;

function readHeader(headers: HeaderSource, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  const record = headers as Record<string, string | undefined>;
  const lower = name.toLowerCase();
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === lower) {
      const value = record[key];
      return typeof value === "string" ? value : null;
    }
  }
  return null;
}

/**
 * Verify a webhook signature against the raw body.
 *
 * `rawBody` is the request body read once as text (`await request.text()`),
 * NOT a re-serialized object.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string,
): VerificationResult {
  if (!signatureHeader) return { ok: false, reason: "missing-signature" };
  if (!webhookSecret) return { ok: false, reason: "missing-secret" };

  const expected = crypto.createHmac("sha256", webhookSecret).update(rawBody, "utf8").digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(signatureHeader, "utf8");

  // timingSafeEqual throws when lengths differ, so guard first. A wrong-length
  // signature is simply invalid, not an error.
  if (expectedBuf.length !== providedBuf.length) {
    return { ok: false, reason: "length-mismatch" };
  }
  if (!crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    return { ok: false, reason: "invalid-signature" };
  }
  return { ok: true };
}

/** Convenience wrapper that pulls the signature header itself. */
export function verifyWebhook(
  rawBody: string,
  headers: HeaderSource,
  webhookSecret: string,
): VerificationResult {
  return verifyWebhookSignature(rawBody, readHeader(headers, SIGNATURE_HEADER), webhookSecret);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entity(event: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const payload = event.payload;
  if (!isRecord(payload)) return null;
  const wrapper = payload[key];
  if (!isRecord(wrapper)) return null;
  const inner = wrapper.entity;
  return isRecord(inner) ? inner : null;
}

function stringField(source: Record<string, unknown> | null, key: string): string | null {
  if (!source) return null;
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function numberField(source: Record<string, unknown> | null, key: string): number | null {
  if (!source) return null;
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Parse a webhook body into the fields the app needs, defensively.
 *
 * Unknown or malformed shapes yield nulls rather than throwing - a webhook
 * handler must always be able to respond, and a 2xx "nothing to do" is safer
 * than a 5xx retry loop for a payload we simply do not understand.
 *
 * Remember: `payment.failed` is not terminal; a later `payment.captured` for
 * the same payment can still arrive and should be allowed to mark it paid.
 */
export function parseWebhookEvent(rawBody: string): ParsedWebhookEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return emptyEvent();
  }
  if (!isRecord(parsed)) return emptyEvent();

  const event = typeof parsed.event === "string" ? parsed.event : "";
  const payment = entity(parsed, "payment");
  const order = entity(parsed, "order");

  return {
    event,
    paymentId: stringField(payment, "id"),
    // Prefer the payment's order_id (the join key to our Order); the order
    // entity is present on order.paid and is a fallback.
    orderId: stringField(payment, "order_id") ?? stringField(order, "id"),
    amountPaise: numberField(payment, "amount") ?? numberField(order, "amount"),
    currency: stringField(payment, "currency") ?? stringField(order, "currency"),
    status: stringField(payment, "status") ?? stringField(order, "status"),
    receipt: stringField(order, "receipt"),
  };
}

function emptyEvent(): ParsedWebhookEvent {
  return {
    event: "",
    paymentId: null,
    orderId: null,
    amountPaise: null,
    currency: null,
    status: null,
    receipt: null,
  };
}

/**
 * Derive a stable idempotency key for a webhook delivery.
 *
 * The signature is NOT a unique event id - retried deliveries carry the same
 * one. Razorpay's `x-razorpay-event-id` is unique per event, so prefer it.
 * Otherwise fall back to a SHA-256 hash of the raw body: a byte-identical
 * retry dedupes correctly, and two semantically different events always
 * produce different bytes (and therefore different hashes).
 *
 * The caller should store this as `(provider: "RAZORPAY", providerEventId)`.
 */
export function deriveEventKey(headers: HeaderSource, rawBody: string): string {
  const headerEventId = readHeader(headers, EVENT_ID_HEADER);
  if (headerEventId) return headerEventId;
  return crypto.createHash("sha256").update(rawBody, "utf8").digest("hex");
}
