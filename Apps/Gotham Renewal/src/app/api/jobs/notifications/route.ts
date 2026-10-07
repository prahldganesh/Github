/**
 * Notification worker endpoint.
 *
 * GET/POST /api/jobs/notifications
 *
 * A cron (Vercel Cron, or any scheduler) calls this to drain the outbox. It is
 * a route rather than a long-running process because the deployment target is
 * serverless, and a short, bounded run fits a function invocation. Nothing here
 * is time-critical: the order is already committed and the job is durable, so a
 * delay only delays the owner's alert.
 *
 * AUTHENTICATION. Two accepted secrets, because two kinds of caller exist:
 *   - `CRON_SECRET` - Vercel Cron sends this automatically as
 *     `Authorization: Bearer <CRON_SECRET>` when the variable is set on the
 *     project. This is Vercel's own convention.
 *   - `JOB_RUNNER_SECRET` - for a self-hosted scheduler (cron, GitHub Actions)
 *     or manual invocation, which does not know about CRON_SECRET.
 * Both are compared in constant time. An unauthenticated endpoint that sends
 * WhatsApp messages is an abuse vector: anyone could loop it and burn the
 * message quota.
 */
import { NextResponse, type NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { checkJobRequest } from "@/lib/jobs/auth";
import { processDueNotifications } from "@/lib/notifications/worker";

export const dynamic = "force-dynamic";
// Bound the function's runtime. The worker processes a bounded batch, so a
// generous ceiling is plenty and a hung provider cannot hold the function open
// indefinitely.
export const maxDuration = 60;

async function run(request: NextRequest) {
  const auth = checkJobRequest(request);

  if (auth === "unconfigured") {
    // A deployment error, not an attack: the schedule will 401 every single run
    // and the outbox will never drain. Orders still place, so nothing looks
    // broken until the owner notices the alerts stopped. Make it loud.
    logger.error(
      "notification cron is not authenticated: neither CRON_SECRET nor JOB_RUNNER_SECRET is set, so every scheduled run is being refused and notifications will never be sent",
    );
    return NextResponse.json({ error: "Job authentication is not configured" }, { status: 401 });
  }

  if (auth === "unauthorised") {
    // A secret is configured; this caller supplied the wrong one.
    logger.warn("notification cron rejected an unauthorised request");
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  try {
    const result = await processDueNotifications(25);
    return NextResponse.json(result);
  } catch (error) {
    // The worker is designed not to throw, so reaching here means something
    // unexpected. Report a 500 so the scheduler alerts rather than silently
    // succeeding.
    logger.error("notification job run failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Job run failed" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  return run(request);
}

// Vercel Cron issues a GET. Support both so the same URL works either way.
export async function GET(request: NextRequest) {
  return run(request);
}
