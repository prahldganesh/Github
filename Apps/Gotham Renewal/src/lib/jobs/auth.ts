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
 */
import "server-only";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

function secretMatches(provided: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  // Length is not secret, and timingSafeEqual throws on a mismatch, so check it
  // first and compare only equal-length buffers.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** True when the request carries a valid bearer secret. */
export function authorisedJobRequest(request: Request): boolean {
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!provided) return false;

  const config = env();
  return (
    secretMatches(provided, config.JOB_RUNNER_SECRET) ||
    secretMatches(provided, process.env.CRON_SECRET)
  );
}
