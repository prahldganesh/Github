/**
 * Shared authentication for scheduled internal endpoints.
 *
 * Two secrets are accepted because two kinds of caller exist:
 *   - `CRON_SECRET` - Vercel Cron sends this automatically as
 *     `Authorization: Bearer <CRON_SECRET>` when the variable is set on the
 *     project. This is Vercel's own documented convention.
 *   - `JOB_RUNNER_SECRET` - a self-hosted scheduler or a manual curl, which does
 *     not know about CRON_SECRET.
 *
 * Both are compared in constant time. These endpoints change orders and spend
 * money-adjacent quota, so an unauthenticated caller must never reach them.
 *
 * WHY THE RESULT IS NOT A BOOLEAN. "Rejected" has two very different causes, and
 * conflating them hides a real production failure:
 *
 *   - `unconfigured` - no accepted secret is set at all, so EVERY scheduled call
 *     is being refused. Vercel Cron will run, get a 401, and the notification
 *     outbox will silently never drain: orders still place fine, so nothing looks
 *     broken until someone notices the owner is getting no alerts. This is a
 *     misconfiguration and is logged as an error naming the variable to set.
 *   - `unauthorised` - a secret IS configured and this caller supplied the wrong
 *     one. A warning, not an error: this is what an attacker or a mistyped curl
 *     looks like, and it is expected noise rather than a config fault.
 *
 * The distinction is the whole reason this returns a status instead of a bool.
 */
import "server-only";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

export type JobAuthResult = "ok" | "unconfigured" | "unauthorised";

function secretMatches(provided: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  // Length is not secret, and timingSafeEqual throws on a mismatch, so check it
  // first and compare only equal-length buffers.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Whether any accepted secret is configured. Surfaced for startup diagnostics. */
export function cronAuthConfigured(): boolean {
  return Boolean(env().JOB_RUNNER_SECRET || process.env.CRON_SECRET);
}

/** Authenticate a scheduled call, distinguishing misconfiguration from rejection. */
export function checkJobRequest(request: Request): JobAuthResult {
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";

  // A `Bearer` header is present and matches either accepted secret.
  if (
    provided &&
    (secretMatches(provided, env().JOB_RUNNER_SECRET) ||
      secretMatches(provided, process.env.CRON_SECRET))
  ) {
    return "ok";
  }

  // Nothing matched. Why matters: if no secret is configured at all, the
  // schedule can never succeed and that is a deployment error, not a rejection.
  if (!cronAuthConfigured()) return "unconfigured";
  return "unauthorised";
}
