/**
 * Order access tokens.
 *
 * WHY THIS EXISTS. The confirmation page used to be protected only by the order
 * id being a UUID. That is not access control: a UUID appears in browser
 * history, in `Referer` headers, in server access logs and in any proxy in
 * between. Anyone who sees one could read that customer's name, address and
 * phone number. "Unguessable" is not "authorised".
 *
 * So an order id alone is no longer enough. Viewing a confirmation requires a
 * token that:
 *   - is bound to that specific order id (a token for order A cannot open order
 *     B, even though both use the same secret),
 *   - expires, so a leaked link stops working,
 *   - is signed, so it cannot be forged or extended.
 *
 * This is a capability URL: possession of the link grants access, which is the
 * standard, appropriate pattern for guest checkout. It is deliberately NOT a
 * session - the customer has no account and should not have to make one.
 */
import crypto from "node:crypto";

/** Confirmation links stay valid for a week: long enough to bookmark or email. */
export const ORDER_ACCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Derive a purpose-bound key from the app secret.
 *
 * Reusing one secret for two purposes (admin sessions and order links) means a
 * weakness in one protocol can be leveraged against the other. HMAC-deriving a
 * separate key per purpose costs nothing and removes that coupling.
 */
function deriveKey(secret: string, purpose: string): Buffer {
  return crypto.createHmac("sha256", secret).update(purpose).digest();
}

function signatureFor(orderId: string, expiresAt: number, secret: string): string {
  return crypto
    .createHmac("sha256", deriveKey(secret, "order-access-v1"))
    .update(`${orderId}.${expiresAt}`)
    .digest("base64url");
}

/**
 * Mint a token for an order. Format: `<expiresAt>.<signature>`.
 *
 * The order id is not carried in the token - it is already in the URL path - but
 * it IS signed, which is what stops a token being replayed against a different
 * order.
 */
export function createOrderAccessToken(
  orderId: string,
  secret: string,
  ttlMs = ORDER_ACCESS_TTL_MS,
  now = Date.now(),
): string {
  const expiresAt = now + ttlMs;
  return `${expiresAt}.${signatureFor(orderId, expiresAt, secret)}`;
}

/**
 * Whether a token authorises access to this order.
 *
 * Returns false for every failure - missing, malformed, expired, or signed for
 * a different order - because the caller turns all of them into the same 404.
 * Distinguishing them would tell an attacker which order ids are real.
 */
export function verifyOrderAccessToken(
  orderId: string,
  token: string | undefined | null,
  secret: string,
  now = Date.now(),
): boolean {
  if (!token) return false;

  const separator = token.indexOf(".");
  if (separator === -1) return false;

  const expiresAtRaw = token.slice(0, separator);
  const providedSignature = token.slice(separator + 1);
  if (!expiresAtRaw || !providedSignature) return false;

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt)) return false;
  if (expiresAt <= now) return false;

  const expected = signatureFor(orderId, expiresAt, secret);
  const provided = Buffer.from(providedSignature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (provided.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(provided, expectedBuffer);
}
