/**
 * Payment-event idempotency check, under real concurrency.
 *
 * The claim being tested: "the unique constraint is what makes webhooks
 * idempotent, not application logic". The only way to test that is to fire
 * duplicate deliveries AT THE SAME TIME against a real database. A sequential
 * test ("insert, then insert again") would pass even with a broken check-then-
 * insert implementation, because the race window is never entered.
 *
 *   A. N concurrent identical deliveries -> exactly ONE reports "new".
 *   B. A delivery whose order update fails rolls the event row back, so a
 *      retry can still apply it (the "never stuck unpaid" property).
 *   C. Different events for the same order are all accepted.
 *
 * Run: npm run check:webhook-idempotency   (needs Postgres)
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { withUtcSession } from "../src/lib/db/connection";
import { recordPaymentEvent } from "../src/lib/payments/events";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: withUtcSession(process.env.DATABASE_URL!) }),
});

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = "") {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function makeOrder(stamp: number, suffix: string) {
  return prisma.order.create({
    data: {
      orderNumber: `WH-${stamp}-${suffix}`,
      customerName: "Webhook Test",
      customerPhone: "9876543210",
      address: "1 Webhook Road, Somewhere",
      city: "Bengaluru",
      state: "Karnataka",
      pincode: "560001",
      subtotal: 45000, shipping: 0, total: 45000,
      paymentMethod: "RAZORPAY", paymentStatus: "PENDING", orderStatus: "NEW",
    },
  });
}

async function main() {
  const stamp = Date.now();

  // --- A. concurrent duplicate delivery -----------------------------------
  const order = await makeOrder(stamp, "A");
  const CONCURRENCY = 12;
  const eventId = `evt_concurrent_${stamp}`;

  // Fire all deliveries at once. If idempotency were implemented in the
  // application, several of these would pass the "not yet processed" check
  // before any of them inserted.
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, () =>
      prisma
        .$transaction((tx) =>
          recordPaymentEvent(tx, {
            orderId: order.id,
            provider: "RAZORPAY",
            providerEventId: eventId,
            eventType: "payment.captured",
            payload: { note: "concurrent" },
          }),
        )
        .then((result) => result.outcome)
        .catch((error: unknown) => `error:${(error as { code?: string }).code ?? "?"}`),
    ),
  );

  const news = results.filter((r) => r === "new").length;
  const duplicates = results.filter((r) => r === "duplicate").length;
  const errors = results.filter((r) => String(r).startsWith("error")).length;

  const stored = await prisma.paymentEvent.count({
    where: { provider: "RAZORPAY", providerEventId: eventId },
  });

  check(
    `${CONCURRENCY} concurrent identical deliveries -> exactly one is "new"`,
    news === 1,
    `new=${news}, duplicate=${duplicates}, errors=${errors}`,
  );
  check(
    "the rest are reported as duplicates, not errors",
    duplicates === CONCURRENCY - 1,
    `duplicate=${duplicates}`,
  );
  check("exactly one event row was stored", stored === 1, `rows=${stored}`);

  // --- A2. sequential redelivery behaves the same -------------------------
  const again = await prisma.$transaction((tx) =>
    recordPaymentEvent(tx, {
      orderId: order.id,
      provider: "RAZORPAY",
      providerEventId: eventId,
      eventType: "payment.captured",
      payload: { note: "later redelivery" },
    }),
  );
  check(
    "a later redelivery of the same event is a duplicate",
    again.outcome === "duplicate",
    `outcome=${again.outcome}`,
  );

  // --- B. a failed transaction rolls the event row back -------------------
  const rollbackOrder = await makeOrder(stamp, "B");
  const rollbackEventId = `evt_rollback_${stamp}`;

  try {
    await prisma.$transaction(async (tx) => {
      await recordPaymentEvent(tx, {
        orderId: rollbackOrder.id,
        provider: "RAZORPAY",
        providerEventId: rollbackEventId,
        eventType: "payment.captured",
        payload: { note: "will roll back" },
      });
      // Simulate the order update failing after the event was recorded. If the
      // event row survived this, the real delivery would be treated as a
      // duplicate on retry and the payment would never be applied.
      throw new Error("simulated failure applying payment");
    });
  } catch {
    // Expected.
  }

  const survived = await prisma.paymentEvent.count({
    where: { provider: "RAZORPAY", providerEventId: rollbackEventId },
  });
  check(
    "a failed payment application rolls its event row back (order cannot get stuck unpaid)",
    survived === 0,
    `rows=${survived}`,
  );

  // And the retry after the failure is accepted as new.
  const retry = await prisma.$transaction((tx) =>
    recordPaymentEvent(tx, {
      orderId: rollbackOrder.id,
      provider: "RAZORPAY",
      providerEventId: rollbackEventId,
      eventType: "payment.captured",
      payload: { note: "retry after failure" },
    }),
  );
  check(
    "the retry after a rolled-back attempt is accepted as new",
    retry.outcome === "new",
    `outcome=${retry.outcome}`,
  );

  // --- C. distinct events for one order are all accepted ------------------
  const multi = await makeOrder(stamp, "C");
  const outcomes = await Promise.all(
    ["captured", "failed", "refunded"].map((kind, index) =>
      prisma
        .$transaction((tx) =>
          recordPaymentEvent(tx, {
            orderId: multi.id,
            provider: "RAZORPAY",
            providerEventId: `evt_multi_${stamp}_${index}`,
            eventType: `payment.${kind}`,
            payload: {},
          }),
        )
        .then((r) => r.outcome),
    ),
  );
  check(
    "distinct events for one order are all accepted",
    outcomes.every((o) => o === "new"),
    outcomes.join(","),
  );

  // --- D. the same event id from a different provider is separate ---------
  const cross = await prisma.$transaction((tx) =>
    recordPaymentEvent(tx, {
      orderId: multi.id,
      provider: "SOMETHINGELSE",
      providerEventId: eventId, // same id as the Razorpay one
      eventType: "payment.captured",
      payload: {},
    }),
  );
  check(
    "the unique key is (provider, event id), not the event id alone",
    cross.outcome === "new",
    `outcome=${cross.outcome}`,
  );

  // --- cleanup -------------------------------------------------------------
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: `WH-${stamp}` } } });
  const leftover = await prisma.paymentEvent.count({
    where: { providerEventId: { contains: String(stamp) } },
  });
  check("cleanup left no stray payment events (cascade works)", leftover === 0, `rows=${leftover}`);

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
    await prisma.$disconnect();
  });
