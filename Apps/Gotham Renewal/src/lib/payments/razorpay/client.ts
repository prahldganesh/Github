/**
 * Razorpay REST client.
 *
 * Talks to the stable, documented REST API directly with `fetch` and Node's
 * `crypto` for Basic auth - no SDK dependency.
 *
 * Auth: HTTP Basic, username = key_id, password = key_secret, base64-encoded.
 * The credentials are passed in; this module never reads env. It also never
 * logs or returns the secret - only Razorpay's public `key_id`.
 *
 * Expected API failures are returned as typed results, never thrown.
 */
import { logger, errorFields, type LogFields } from "@/lib/logger";
import type {
  CreateOrderResult,
  CreateRefundResult,
  FetchRefundResult,
  RazorpayRefund,
  CreateRazorpayOrderInput,
  FetchPaymentResult,
  RazorpayConfig,
  RazorpayError,
  RazorpayOrder,
  RazorpayPayment,
} from "./types";

const DEFAULT_BASE_URL = "https://api.razorpay.com";
const REQUEST_TIMEOUT_MS = 10_000;

function logApiFailure(fields: LogFields): void {
  logger.warn("razorpay request failed", fields);
}

function baseUrl(config: RazorpayConfig): string {
  return (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function basicAuthHeader(config: RazorpayConfig): string {
  const token = Buffer.from(`${config.keyId}:${config.keySecret}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

type RawResult =
  | { ok: true; data: unknown }
  | { ok: false; error: RazorpayError };

/** Read Razorpay's `{ error: { code, description } }` shape, falling back to the HTTP status. */
async function readErrorBody(response: Response): Promise<RazorpayError> {
  let code = `HTTP_${response.status}`;
  let description = `Razorpay request failed with status ${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown } | null;
    const raw = body?.error;
    if (raw && typeof raw === "object") {
      const err = raw as Record<string, unknown>;
      if (typeof err.code === "string" && err.code) code = err.code;
      if (typeof err.description === "string" && err.description) description = err.description;
    }
  } catch {
    // Non-JSON body: keep the HTTP fallback.
  }
  return { code, description, status: response.status };
}

async function request(
  config: RazorpayConfig,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<RawResult> {
  const url = `${baseUrl(config)}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: {
        Authorization: basicAuthHeader(config),
        "Content-Type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const isTimeout = name === "TimeoutError" || name === "AbortError";
    const result: RazorpayError = isTimeout
      ? { code: "TIMEOUT", description: `Razorpay request timed out after ${REQUEST_TIMEOUT_MS}ms` }
      : {
          code: "NETWORK_ERROR",
          description: error instanceof Error ? error.message : String(error),
        };
    logApiFailure({
      provider: "RAZORPAY",
      path,
      code: result.code,
      ...errorFields(error),
    });
    return { ok: false, error: result };
  }

  if (!response.ok) {
    const error = await readErrorBody(response);
    logApiFailure({
      provider: "RAZORPAY",
      path,
      status: response.status,
      code: error.code,
      description: error.description,
    });
    return { ok: false, error };
  }

  try {
    return { ok: true, data: await response.json() };
  } catch (error) {
    logApiFailure({
      provider: "RAZORPAY",
      path,
      code: "INVALID_RESPONSE",
      ...errorFields(error),
    });
    return {
      ok: false,
      error: { code: "INVALID_RESPONSE", description: "Razorpay returned a non-JSON body" },
    };
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Derive the public-safe order subset; the response is untrusted input. */
function toRazorpayOrder(data: unknown): RazorpayOrder | null {
  if (!data || typeof data !== "object") return null;
  const raw = data as Record<string, unknown>;
  const id = asString(raw.id);
  const amount = asNumber(raw.amount);
  const currency = asString(raw.currency);
  if (!id || amount === null || !currency) return null;
  return {
    id,
    amount,
    currency,
    status: asString(raw.status) ?? "created",
    receipt: asString(raw.receipt),
  };
}

function toRazorpayPayment(data: unknown): RazorpayPayment | null {
  if (!data || typeof data !== "object") return null;
  const raw = data as Record<string, unknown>;
  const id = asString(raw.id);
  if (!id) return null;
  return {
    id,
    orderId: asString(raw.order_id),
    amount: asNumber(raw.amount) ?? 0,
    currency: asString(raw.currency) ?? "INR",
    status: asString(raw.status) ?? "unknown",
  };
}

/**
 * Create a Razorpay Order for an amount we computed server-side.
 *
 * `amountPaise` must be a positive integer; Razorpay's own minimum is 100.
 * `receipt` is effectively an idempotency key and must be unique per account,
 * so a retried create with the same receipt is rejected by Razorpay.
 */
export async function createRazorpayOrder(
  config: RazorpayConfig,
  input: CreateRazorpayOrderInput,
): Promise<CreateOrderResult> {
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
    return {
      ok: false,
      error: {
        code: "INVALID_AMOUNT",
        description: `amountPaise must be a positive integer, got ${input.amountPaise}`,
      },
    };
  }

  const result = await request(config, "/v1/orders", {
    method: "POST",
    body: {
      amount: input.amountPaise,
      currency: "INR",
      receipt: input.receipt,
      notes: input.notes ?? {},
    },
  });

  if (!result.ok) return { ok: false, error: result.error };

  const order = toRazorpayOrder(result.data);
  if (!order) {
    return {
      ok: false,
      error: { code: "INVALID_RESPONSE", description: "Razorpay order response was missing id/amount" },
    };
  }
  return { ok: true, order };
}

/**
 * Convenience for manual reconciliation: fetch a payment by id.
 * The webhook is the paid trigger; this is for support tooling.
 */
export async function fetchPayment(
  config: RazorpayConfig,
  paymentId: string,
): Promise<FetchPaymentResult> {
  if (!paymentId) {
    return {
      ok: false,
      error: { code: "INVALID_PAYMENT_ID", description: "paymentId must be a non-empty string" },
    };
  }

  const result = await request(config, `/v1/payments/${encodeURIComponent(paymentId)}`, {
    method: "GET",
  });

  if (!result.ok) return { ok: false, error: result.error };

  const payment = toRazorpayPayment(result.data);
  if (!payment) {
    return {
      ok: false,
      error: { code: "INVALID_RESPONSE", description: "Razorpay payment response was missing id" },
    };
  }
  return { ok: true, payment };
}

/** Derive the refund subset; the response is untrusted input. */
function toRazorpayRefund(data: unknown): RazorpayRefund | null {
  if (!data || typeof data !== "object") return null;
  const raw = data as Record<string, unknown>;
  const id = asString(raw.id);
  const paymentId = asString(raw.payment_id);
  const amount = asNumber(raw.amount);
  if (!id || !paymentId || amount === null) return null;
  return {
    id,
    paymentId,
    amount,
    currency: asString(raw.currency) ?? "INR",
    status: asString(raw.status) ?? "unknown",
    speedProcessed: asString(raw.speed_processed),
  };
}

/**
 * Is this failure UNCERTAIN - i.e. the provider may have accepted the request
 * even though we did not get a clean answer?
 *
 * This matters enormously for refunds. A timeout or a dropped connection means
 * the refund may exist. Retrying blindly could refund the customer twice, so
 * these outcomes must be reconciled against the provider rather than retried.
 * A 4xx, by contrast, is a definite refusal: the provider understood and said no.
 *
 * A 5xx sits in between and is treated as uncertain deliberately - the safest
 * assumption when money may have moved.
 */
export function isUncertainOutcome(error: RazorpayError): boolean {
  if (error.code === "TIMEOUT" || error.code === "NETWORK_ERROR") return true;
  if (typeof error.status === "number" && error.status >= 500) return true;
  return false;
}

/**
 * Refund a captured payment.
 *
 * `idempotencyKey` is sent as the refund `receipt`, which Razorpay treats as an
 * idempotency key: a second request with the same receipt is refused with
 * "Duplicate receipt found for this refund request". That is a second line of
 * defence behind the unique `refunds.idempotency_key` column - if our own guard
 * were ever bypassed, the provider still would not refund twice.
 *
 * A FULL refund needs no `amount`; Razorpay refunds the whole captured amount.
 * We pass it explicitly anyway so the intent is recorded in the request, and
 * omit the `speed` parameter: `optimum`/instant refunds are not supported by
 * every payment method, and a plain refund always works.
 */
export async function createRefund(
  config: RazorpayConfig,
  input: { paymentId: string; amountPaise: number; idempotencyKey: string; notes?: Record<string, string> },
): Promise<CreateRefundResult> {
  if (!input.paymentId) {
    return { ok: false, error: { code: "INVALID_PAYMENT_ID", description: "paymentId is required" } };
  }
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
    return {
      ok: false,
      error: {
        code: "INVALID_AMOUNT",
        description: `amountPaise must be a positive integer, got ${input.amountPaise}`,
      },
    };
  }

  const result = await request(config, `/v1/payments/${encodeURIComponent(input.paymentId)}/refund`, {
    method: "POST",
    body: {
      amount: input.amountPaise,
      // Razorpay's idempotency key for refunds.
      receipt: input.idempotencyKey,
      notes: { ...(input.notes ?? {}), idempotency_key: input.idempotencyKey },
    },
  });

  if (!result.ok) return { ok: false, error: result.error };

  const refund = toRazorpayRefund(result.data);
  if (!refund) {
    return {
      ok: false,
      error: { code: "INVALID_RESPONSE", description: "Razorpay refund response was missing id" },
    };
  }
  return { ok: true, refund };
}

/**
 * Fetch one refund by id.
 *
 * The reconciliation half of the refund flow: after an uncertain outcome we ask
 * the provider what actually happened instead of guessing.
 */
export async function fetchRefund(
  config: RazorpayConfig,
  paymentId: string,
  refundId: string,
): Promise<FetchRefundResult> {
  if (!paymentId || !refundId) {
    return { ok: false, error: { code: "INVALID_REFUND_ID", description: "paymentId and refundId are required" } };
  }

  const result = await request(
    config,
    `/v1/payments/${encodeURIComponent(paymentId)}/refunds/${encodeURIComponent(refundId)}`,
    { method: "GET" },
  );

  if (!result.ok) return { ok: false, error: result.error };

  const refund = toRazorpayRefund(result.data);
  if (!refund) {
    return { ok: false, error: { code: "INVALID_RESPONSE", description: "Razorpay refund response was missing id" } };
  }
  return { ok: true, refund };
}

/**
 * List the refunds already recorded against a payment.
 *
 * The other reconciliation tool, and the one that matters after a TIMEOUT: if
 * we never learned the refund id, listing is how we discover whether a refund
 * with our receipt already exists before creating another.
 */
export async function listRefundsForPayment(
  config: RazorpayConfig,
  paymentId: string,
): Promise<{ ok: true; refunds: RazorpayRefund[] } | { ok: false; error: RazorpayError }> {
  if (!paymentId) {
    return { ok: false, error: { code: "INVALID_PAYMENT_ID", description: "paymentId is required" } };
  }

  const result = await request(config, `/v1/payments/${encodeURIComponent(paymentId)}/refunds`, {
    method: "GET",
  });
  if (!result.ok) return { ok: false, error: result.error };

  const raw = result.data as { items?: unknown } | undefined;
  const items = Array.isArray(raw?.items) ? raw.items : [];
  const refunds = items.map(toRazorpayRefund).filter((refund): refund is RazorpayRefund => refund !== null);
  return { ok: true, refunds };
}
