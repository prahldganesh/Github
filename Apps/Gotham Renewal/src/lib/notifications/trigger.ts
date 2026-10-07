/**
 * Opportunistic outbox drain.
 *
 * WHY THIS EXISTS, and how it relates to the cron.
 *
 * The notification outbox (ADR-0006) means an order commits and records "an
 * alert is owed" in one transaction. Something then has to actually send it.
 * That was the scheduled worker, running every minute.
 *
 * Two problems with relying on the schedule alone:
 *
 *   1. LATENCY. The owner learns about an order up to a minute late. Fine, but
 *      needlessly slow when the request that just created the order is sitting
 *      right here.
 *   2. IT IS NOT ALWAYS AVAILABLE. Vercel's Hobby plan refuses sub-daily cron
 *      expressions - the deploy is rejected outright. So on the free plan the
 *      schedule can only run once a day, which would mean an alert arriving up
 *      to 24 hours after the order. Unacceptable for a shop.
 *
 * So the order path now drains the outbox itself, using Next's `after()` to run
 * the work AFTER the response has been sent. That gives:
 *
 *   - immediate delivery in the happy path (no cron involved);
 *   - the response is never blocked or failed by it - `after()` runs post-response,
 *     so a slow or down Meta API still cannot touch the customer's checkout;
 *   - the scheduled drain remains, now purely a SAFETY NET for retries and for
 *     anything the opportunistic pass could not deliver (Meta down, process
 *     replaced, etc.).
 *
 * The durability guarantee is unchanged either way: the job row is committed
 * before any of this runs, so a crash here loses nothing.
 *
 * `after()` throws if called outside a request scope (a script, a test), so it
 * is guarded - there the caller drains synchronously or the cron does.
 */
import "server-only";
import { after } from "next/server";
import { logger, errorFields } from "@/lib/logger";
import { processDueNotifications } from "./worker";

/**
 * Schedule a best-effort drain for after the current response.
 *
 * Never throws. A failure here is invisible to the caller by design: the job is
 * durable and the scheduled drain will pick it up.
 */
export function triggerNotificationDrain(limit = 10): void {
  try {
    after(async () => {
      try {
        const result = await processDueNotifications(limit);
        if (result.claimed > 0) {
          logger.info("opportunistic notification drain", { ...result });
        }
      } catch (error) {
        // Swallowed deliberately: the outbox row survives and the scheduled
        // drain retries. Surfacing this would suggest the order was affected,
        // and it was not.
        logger.warn("opportunistic notification drain failed; the scheduled drain will retry", errorFields(error));
      }
    });
  } catch (error) {
    // Outside a request scope `after()` is unavailable. Not an error worth
    // surfacing - the scheduled drain covers it.
    logger.debug("no request scope for an immediate drain; relying on the schedule", errorFields(error));
  }
}
