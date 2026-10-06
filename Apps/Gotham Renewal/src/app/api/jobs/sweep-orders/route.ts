/**
 * Abandoned-order sweep endpoint.
 *
 * GET/POST /api/jobs/sweep-orders
 *
 * A cron calls this to cancel unpaid online orders and return their stock. It
 * exists because stock is reserved at order creation, so an abandoned checkout
 * holds a unit indefinitely (ADR-0003).
 *
 * Nothing here is urgent: an order that should have been swept an hour ago is
 * swept on the next run. The whole operation is safe to run concurrently with
 * itself and with live payments - see `lib/orders/sweep.ts` for the guard.
 *
 * Authenticated by `CRON_SECRET` (Vercel Cron) or `JOB_RUNNER_SECRET`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { authorisedJobRequest } from "@/lib/jobs/auth";
import { sweepStalePendingOrders, STALE_PENDING_MINUTES } from "@/lib/orders/sweep";

export const dynamic = "force-dynamic";
// Bound the function's runtime. The sweep processes a bounded batch of orders,
// each in its own short transaction.
export const maxDuration = 60;

async function run(request: NextRequest) {
  if (!authorisedJobRequest(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  // A query parameter lets a human run a narrower or wider sweep by hand
  // without a deploy, e.g. ?minutes=5 while testing.
  const requested = Number(request.nextUrl.searchParams.get("minutes"));
  const minutes =
    Number.isFinite(requested) && requested > 0 ? requested : STALE_PENDING_MINUTES;

  try {
    const result = await sweepStalePendingOrders(minutes);
    logger.info("order sweep complete", { ...result, olderThanMinutes: minutes });
    return NextResponse.json({ ...result, olderThanMinutes: minutes });
  } catch (error) {
    // The sweep is designed not to throw, so reaching here is unexpected.
    // A 500 makes the scheduler alert rather than silently succeeding.
    logger.error("order sweep failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Sweep failed" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return run(request);
}

export async function POST(request: NextRequest) {
  return run(request);
}
