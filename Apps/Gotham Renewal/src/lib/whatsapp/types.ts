/**
 * WhatsApp Cloud API types.
 *
 * The transport is plain HTTPS + JSON, so the whole integration is a thin
 * `fetch` wrapper. These types are deliberately environment-agnostic: no
 * `server-only`, no `@/lib/env`, no Prisma. The caller wires in a
 * `WhatsAppConfig`; that keeps this module pure and runnable under the
 * plain-Node test runner.
 *
 * See docs/research/whatsapp-cloud-api.md for the source of every shape here.
 */
import type { Paise } from "@/lib/money";

/** Everything the client needs to reach the Cloud API. Never log `accessToken`. */
export type WhatsAppConfig = {
  /** The business phone number ID (numeric), not the display number. */
  phoneNumberId: string;
  /** Bearer token. Opaque - do not parse. Treat as a password. */
  accessToken: string;
  /** Graph API version, e.g. "v21.0". */
  graphVersion: string;
};

/**
 * One template variable. `type` is always "text" for our templates.
 * Named templates (recommended, `parameter_format: "named"`) also carry
 * `parameter_name`; positional variables omit it.
 */
export type TemplateParameter = {
  type: "text";
  text: string;
  parameter_name?: string;
};

export type SendTemplateInput = {
  /** Recipient WhatsApp number, digits (E.164, leading "+" optional). */
  to: string;
  templateName: string;
  languageCode: string;
  bodyParameters: readonly TemplateParameter[];
  /** Optional text-header parameters, in order. */
  headerParameters?: readonly TemplateParameter[];
  /** Dynamic URL-button suffixes, one per URL button, in button order. */
  buttonUrlParameters?: readonly string[];
};

export type SendTextInput = {
  to: string;
  body: string;
  /** Render URLs in the body as previews. Defaults to false. */
  previewUrl?: boolean;
};

/** Per-call transport options. */
export type SendOptions = {
  /** Request timeout in milliseconds. Defaults to 10_000. */
  timeoutMs?: number;
};

/**
 * Structural input for the `new_order_alert` template.
 *
 * Intentionally NOT the Prisma `Order` type: that model does not exist yet and
 * the shaping layer should not couple to it. `totalPaise` is integer paise, per
 * the project's money rule.
 */
export type NewOrderAlertInput = {
  orderNumber: string;
  customerName: string;
  totalPaise: Paise;
  /** Human label for the payment method/status, e.g. "PAID", "COD". */
  paymentLabel: string;
  orderUrl: string;
};

export type WhatsAppErrorKind = "api" | "network" | "timeout";

/**
 * A normalised failure. The API has no idempotency key, so a retry can
 * double-send - `retryable` is the caller's only signal for that decision.
 * Non-retryable errors should be recorded as FAILED; retryable ones keep the
 * notification PENDING.
 */
export type WhatsAppError = {
  ok: false;
  kind: WhatsAppErrorKind;
  /** Present for `kind: "api"`; absent for network/timeout failures. */
  httpStatus?: number;
  /** Graph error code (numeric). `undefined` when the body was malformed. */
  code?: number;
  /** Graph `error.error_data.details`, the human-readable reason. */
  details?: string;
  message: string;
  fbtraceId?: string;
  retryable: boolean;
};

/** Discriminated result: check `ok` before reading `messageId`. */
export type WhatsAppSendResult = { ok: true; messageId: string } | WhatsAppError;
