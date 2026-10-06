/**
 * The admin authentication gate.
 *
 * WHY THIS IS A FUNCTION AND NOT MIDDLEWARE. Next 16's docs are explicit:
 *
 *   > Always verify authentication and authorization inside each Server
 *   > Function rather than relying on Proxy alone. A matcher change or a
 *   > refactor that moves a Server Function to a different route can silently
 *   > remove Proxy coverage.
 *
 * So every admin page and every admin server action calls `requireAdmin()`.
 * A `proxy.ts` may be added later as a fast redirect for the browsing
 * experience, but it would be a convenience on top of this - never the actual
 * gate. Defence that can be bypassed by editing a matcher is not defence.
 *
 * `cookies()` is async in Next 16 and must be awaited.
 */
import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { SESSION_COOKIE_NAME, verifySessionToken, type SessionPayload } from "./session";

/**
 * Read and verify the current session, without redirecting.
 *
 * Use this where a missing session is not an error (e.g. deciding what to show
 * on the login page). Use `requireAdmin` where it is.
 */
export async function getAdminSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  const result = verifySessionToken(token, env().ADMIN_SESSION_SECRET);
  return result.ok ? result.payload : null;
}

/**
 * Require an authenticated admin, or redirect to the login page.
 *
 * Returns the session so callers can use the subject. Redirecting (rather than
 * throwing) is right for pages; server actions that must not redirect the whole
 * page use `assertAdmin` instead.
 */
export async function requireAdmin(): Promise<SessionPayload> {
  const session = await getAdminSession();
  if (!session) redirect("/admin/login");
  return session;
}

/**
 * Require an authenticated admin, but throw instead of redirecting.
 *
 * For server actions whose failure should surface as an error in the UI rather
 * than a navigation. The caller decides how to present it.
 */
export async function assertAdmin(): Promise<SessionPayload> {
  const session = await getAdminSession();
  if (!session) {
    throw new Error("Not authorised. Please sign in again.");
  }
  return session;
}

/**
 * The cookie options for the session, in one place so set and clear cannot
 * drift apart.
 *
 * - `httpOnly`: JavaScript cannot read it, so an XSS bug cannot steal the
 *   session.
 * - `sameSite: "lax"`: the cookie is not sent on cross-site POSTs, which blunts
 *   CSRF while keeping normal navigation working.
 * - `secure` in production only: `secure` over plain HTTP on localhost would
 *   stop the cookie being stored at all, so it is tied to NODE_ENV.
 * - `path: "/"`: so it is sent to every admin route.
 */
export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}
