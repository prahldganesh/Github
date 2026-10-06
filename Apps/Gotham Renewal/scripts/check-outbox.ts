/**
 * Outbox durability check.
 *
 * Proves the two properties the outbox exists for, against a real database:
 *
 *   A. ATOMICITY. The order and its notification obligation commit together. If
 *      the order transaction rolls back, no notification row survives - and if
 *      the transaction commits, the notification row is there.
 *
 *   B. CRASH RECOVERY. A worker that dies mid-send (or after claiming, before
 *      sending) leaves the job recoverable. This is simulated by claiming a job
 *      and then simply never recording an outcome - exactly what a killed
 *      process looks like - then asserting another run can still claim it once
 *      the lease lapses.
 *
 *   C. OUTAGE RESILIENCE. When the WhatsApp API fails, the job stays retryable
 *      and the ORDER IS UNAFFECTED. No rollback, no lost order.
 *
 * Run: npm run check:outbox   (needs Postgres; no WhatsApp credentials required)
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { withUtcSession } from "../src/lib/db/connection";
import { enqueueNotification, claimDueJobs } from "../src/lib/notifications/outbox";
import { buildOrderAlertPayload } from "../src/lib/notifications/payload";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: withUtcSession(process.env.DATABASE_URL!) }),
});

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = "") {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function alertPayload(orderNumber: string, customerName: string) {
  return buildOrderAlertPayload({
    orderNumber,
    customerName,
    total: 45000,
    paymentStatus: "COD",
    customerPhone: "9876543210",
  });
}

async function main() {
  const stamp = Date.now();

  // --- A. atomicity: a rolled-back order leaves no notification ------------
  const slug = `outbox-a-${stamp}`;
  const product = await prisma.product.create({
    data: { name: "Outbox A", slug, description: "", price: 45000, stock: 5, active: true },
  });

  let rolledBackOrderNumber = "";
  try {
    await prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          orderNumber: `OA-${stamp}`,
          customerName: "Rollback Test",
          customerPhone: "9876543210",
          address: "1 Test Road, Somewhere",
          city: "Bengaluru",
          state: "Karnataka",
          pincode: "560001",
          subtotal: 45000, shipping: 0, total: 45000,
          paymentMethod: "COD", paymentStatus: "COD", orderStatus: "NEW",
          items: { create: [{ productId: product.id, productName: product.name, quantity: 1, unitPrice: 45000, total: 45000 }] },
        },
      });
      rolledBackOrderNumber = order.orderNumber;
      await enqueueNotification(tx, {
        orderId: order.id,
        type: "ORDER_ALERT_BUSINESS",
        recipient: "919999999999",
        payload: alertPayload(order.orderNumber, order.customerName),
      });
      // Now fail the transaction deliberately.
      throw new Error("simulated failure after enqueue");
    });
  } catch {
    // Expected.
  }

  const orphan = await prisma.notification.findFirst({
    where: { order: { orderNumber: rolledBackOrderNumber } },
  });
  const orphanOrder = await prisma.order.findUnique({ where: { orderNumber: rolledBackOrderNumber } });
  check(
    "a rolled-back order leaves no notification behind",
    orphan === null && orphanOrder === null,
    `notification=${orphan ? "present (BUG)" : "none"}, order=${orphanOrder ? "present (BUG)" : "none"}`,
  );

  // --- A2. a committed order DOES have its notification --------------------
  const committedNumber = `OA-${stamp}-ok`;
  const committed = await prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        orderNumber: committedNumber,
        customerName: "Committed Test",
        customerPhone: "9876543210",
        address: "2 Test Road, Somewhere",
        city: "Bengaluru",
        state: "Karnataka",
        pincode: "560001",
        subtotal: 45000, shipping: 0, total: 45000,
        paymentMethod: "COD", paymentStatus: "COD", orderStatus: "NEW",
        items: { create: [{ productId: product.id, productName: product.name, quantity: 1, unitPrice: 45000, total: 45000 }] },
      },
    });
    const job = await enqueueNotification(tx, {
      orderId: order.id,
      type: "ORDER_ALERT_BUSINESS",
      recipient: "919999999999",
      payload: alertPayload(order.orderNumber, order.customerName),
    });
    return { order, job };
  });

  const found = await prisma.notification.findUnique({ where: { id: committed.job.id } });
  check(
    "a committed order carries its notification job",
    found !== null && found.status === "PENDING" && found.attempts === 0,
    `status=${found?.status}, attempts=${found?.attempts}`,
  );

  // --- B. crash recovery: claim, then abandon -----------------------------
  const claimed = await claimDueJobs(50);
  const mine = claimed.find((job) => job.id === committed.job.id);
  check("the worker can claim the job", Boolean(mine), mine ? `attempts now ${mine.attempts}` : "not claimed");

  // Simulate the worker being killed: no markSent, no markFailed. The lease is
  // now held and the row looks in-progress.
  const midCrash = await prisma.notification.findUnique({ where: { id: committed.job.id } });
  check(
    "after a crash the job is leased but still PENDING (not lost)",
    midCrash?.status === "PENDING" && midCrash?.lockedAt !== null,
    `status=${midCrash?.status}, locked=${midCrash?.lockedAt ? "yes" : "no"}`,
  );

  // Immediately, another run must NOT pick it up (the lease is live).
  const tooSoon = await claimDueJobs(50);
  const grabbedEarly = tooSoon.find((job) => job.id === committed.job.id);
  check(
    "a live lease prevents a second worker stealing the job",
    grabbedEarly === undefined,
    grabbedEarly ? "claimed twice (BUG)" : "not re-claimed, correct",
  );

  // Force the lease to look expired, as time passing would do.
  await prisma.notification.update({
    where: { id: committed.job.id },
    data: { lockedAt: new Date(Date.now() - 10 * 60_000) },
  });
  const afterLease = await claimDueJobs(50);
  const reclaimed = afterLease.find((job) => job.id === committed.job.id);
  check(
    "after the lease lapses, the crashed job is reclaimed and retried",
    Boolean(reclaimed),
    reclaimed ? `attempts now ${reclaimed.attempts}` : "job was lost (BUG)",
  );

  // --- C. outage resilience: a failed send must not touch the order -------
  // Simulate what the worker records when the provider is unreachable.
  const { maskProviderFailure } = await import("../src/lib/notifications/simulate-failure");
  const outcome = await maskProviderFailure(committed.job.id, true, 30_000);

  const afterOutage = await prisma.notification.findUnique({ where: { id: committed.job.id } });
  const orderAfterOutage = await prisma.order.findUnique({ where: { id: committed.order.id } });
  check(
    "a WhatsApp outage leaves the job retryable (PENDING, future retry)",
    afterOutage?.status === "PENDING" && (afterOutage?.nextAttemptAt.getTime() ?? 0) > Date.now(),
    `status=${afterOutage?.status}, retryAt in future=${(afterOutage?.nextAttemptAt.getTime() ?? 0) > Date.now()}`,
  );
  check(
    "the order survives the outage untouched",
    orderAfterOutage !== null && orderAfterOutage.orderStatus === "NEW",
    `orderStatus=${orderAfterOutage?.orderStatus}`,
  );
  check(
    "the failure is recorded, not swallowed",
    typeof outcome.lastError === "string" && outcome.lastError.length > 0,
    `lastError=${outcome.lastError?.slice(0, 40)}`,
  );

  // --- D. duplicate enqueue is refused by the database --------------------
  let duplicateRefused = false;
  try {
    await prisma.notification.create({
      data: {
        orderId: committed.order.id,
        type: "ORDER_ALERT_BUSINESS",
        recipient: "919999999999",
        payload: alertPayload("dup", "dup"),
      },
    });
  } catch (error) {
    duplicateRefused = (error as { code?: string }).code === "P2002";
  }
  check("a second alert for the same order is refused by the unique constraint", duplicateRefused);

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Clean up in `finally`, not at the end of the happy path. An earlier
    // version deleted inside `main`, so any throw left `outbox-a-<stamp>`
    // products in the database - which is how a stray product turned up in a
    // later phase's results. A check must not leak fixtures when it fails.
    await prisma.order
      .deleteMany({ where: { orderNumber: { contains: "OA-" } } })
      .catch(() => {});
    await prisma.product
      .deleteMany({ where: { slug: { startsWith: "outbox-a-" } } })
      .catch(() => {});
    await prisma.$disconnect();
  });
