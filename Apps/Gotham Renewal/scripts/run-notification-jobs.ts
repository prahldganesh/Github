#!/usr/bin/env tsx
/**
 * Drain the notification outbox from the command line.
 *
 *   npm run jobs:notifications
 *   npm run jobs:notifications -- --loop     (keep running, polling)
 *
 * The `--loop` mode exists so local development behaves like production
 * without needing a scheduler: place an order, watch the alert job get
 * processed. In production the same work happens via
 * POST /api/jobs/notifications.
 */
import "dotenv/config";
import { processDueNotifications } from "../src/lib/notifications/worker";

const loop = process.argv.includes("--loop");
const intervalMs = 5000;

async function once(): Promise<number> {
  const result = await processDueNotifications(25);
  if (result.claimed > 0) {
    console.log(
      `claimed ${result.claimed}: ${result.sent} sent, ${result.retried} retried, ${result.failed} failed`,
    );
  } else {
    console.log("no due notifications");
  }
  return result.claimed;
}

async function main() {
  if (!loop) {
    await once();
    return;
  }

  console.log(`polling every ${intervalMs}ms (Ctrl-C to stop)`);
  // A simple poll loop. Unhandled errors are logged and the loop continues,
  // because a transient database blip should not kill the worker.
  for (;;) {
    try {
      await once();
    } catch (error) {
      console.error("worker run failed:", error instanceof Error ? error.message : error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    // The pool is owned by lib/db, which does not expose a disconnect helper.
    // Exiting explicitly is fine for a CLI.
    if (!loop) process.exit(process.exitCode ?? 0);
  });
