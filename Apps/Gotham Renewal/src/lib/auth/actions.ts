"use server";

/**
 * Admin sign-in and sign-out server actions.
 *
 * Server actions are POST-only and same-origin by default, which is part of why
 * they are safer than a hand-rolled form endpoint: Next rejects the request if
 * the Origin does not match.
 *
 * Both actions re-verify everything on the server. The login form's `required`
 * attributes are a convenience for the browser; they are not the validation.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { sessionCookieOptions } from "@/lib/auth/guard";
import { SESSION_COOKIE_NAME, SESSION_TTL_MS, createSessionToken } from "@/lib/auth/session";
import { verifyAdminPassword } from "@/lib/auth/verify-admin";
import { rateLimitByKey } from "@/lib/rate-limit";

export type LoginState = { error?: string };

/**
 * Sign in.
 *
 * On success, set the session cookie and redirect to the dashboard. On failure,
 * return a generic message - it does not say whether the password was wrong or
 * the account does not exist, because there is only one account and the
 * distinction only helps an attacker.
 */
export async function loginAction(
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/admin");

  // Rate limit sign-in attempts. Without this, the password is the only thing
  // between the internet and the orders, and guessing is free.
  const limit = await rateLimitByKey("admin-login", { limit: 5, windowMs: 5 * 60_000 });
  if (!limit.ok) {
    return { error: "Too many attempts. Please wait a few minutes and try again." };
  }

  if (!password || !verifyAdminPassword(password)) {
    logger.warn("failed admin login attempt");
    return { error: "Incorrect password." };
  }

  const token = createSessionToken(env().ADMIN_SESSION_SECRET);
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(Math.floor(SESSION_TTL_MS / 1000)));

  logger.info("admin signed in");

  // Only ever redirect to an internal path. A `next` value like
  // "https://evil.example" would otherwise turn the login form into an open
  // redirect, which is a phishing vector.
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/admin");
}

/** Sign out: clear the cookie and return to the login page. */
export async function logoutAction(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE_NAME);
  logger.info("admin signed out");
  redirect("/admin/login");
}
