/**
 * Admin session tokens.
 *
 * A session is a signed cookie, not a row in the database. For a single-admin
 * family store that is the right trade: there is no session table to read on
 * every request, no expiry sweeper, and revoking is done by rotating the
 * `ADMIN_SESSION_SECRET` in the environment.
 *
 * The token format is `<base64url(payload)>.<base64url(hmac)>`:
 *
 *   payload  = { sub: "admin", exp: <ms epoch> }   (NOT secret - it is readable)
 *   hmac     = HMAC-SHA256(secret, base64url(payload))
 *
 * Only the holder of the secret can mint a valid signature, so the payload does
 * not need to be encrypted. But note what this means: the payload is visible to
 * anyone who holds the cookie. Nothing sensitive may go in it - which is why it
 * carries no password, no email, just "who" and "until when".
 *
 * Verification is: signature valid, AND not expired. Both must hold.
 */
import crypto from "node:crypto";

export const SESSION_COOKIE_NAME = "gotham_admin";

/** How long a login lasts. Long enough to be usable, short enough to matter. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export type SessionPayload = {
  /** Subject. Currently always "admin"; a field so roles can be added later. */
  sub: string;
  /** Expiry, milliseconds since epoch. */
  exp: number;
};

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payloadEncoded: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payloadEncoded).digest("base64url");
}

/** Mint a token for a subject, valid for `ttlMs` from now. */
export function createSessionToken(
  secret: string,
  subject = "admin",
  ttlMs = SESSION_TTL_MS,
  now = Date.now(),
): string {
  const payload: SessionPayload = { sub: subject, exp: now + ttlMs };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

export type SessionVerification =
  | { ok: true; payload: SessionPayload }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

/**
 * Verify a token's signature and expiry.
 *
 * Returns a typed result rather than throwing, so a tampered cookie is a normal
 * "not logged in" outcome rather than a 500.
 */
export function verifySessionToken(
  token: string | undefined | null,
  secret: string,
  now = Date.now(),
): SessionVerification {
  if (!token) return { ok: false, reason: "malformed" };

  const separator = token.indexOf(".");
  if (separator === -1) return { ok: false, reason: "malformed" };

  const encoded = token.slice(0, separator);
  const providedSignature = token.slice(separator + 1);
  if (!encoded || !providedSignature) return { ok: false, reason: "malformed" };

  const expectedSignature = sign(encoded, secret);
  const provided = Buffer.from(providedSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");
  if (provided.length !== expected.length) return { ok: false, reason: "bad-signature" };
  if (!crypto.timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "bad-signature" };
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload?.exp !== "number" || typeof payload?.sub !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (payload.exp <= now) return { ok: false, reason: "expired" };

  return { ok: true, payload };
}
