/**
 * Razorpay webhook check, over real HTTP with real signatures.
 *
 * `check:webhook-idempotency` proves the database constraint under concurrency.
 * This proves the ROUTE: that a bad signature is refused before any database
 * work, that a correctly signed capture marks the order paid and queues exactly
 * one alert, and that redelivering it over HTTP changes nothing.
 *
 * It signs payloads with the real `RAZORPAY_WEBHOOK_SECRET`, so it exercises the
 * same verification the live provider would.
 *
 * Run with `npm run dev` up:  npm run check:webhook-route
 */
import "dotenv/config";
import crypto from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { withUtcSession } from "../src/lib/db/connection";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const ENDPOINT = `${BASE_URL}/api/webhooks/razorpay`;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: withUtcSession(process.env.DATABASE_URL!) }),
});

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = "") {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";

function sign(body: string): string {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("hex");
}

async function post(body: string, signature: string | null, eventId?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (signature) headers["X-Razorpay-Signature"] = signature;
  if (eventId) headers["x-razorpay-event-id"] = eventId;
  const response = await fetch(ENDPOINT, { method: "POST", headers, body });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

async function main() {
  if (!WEBHOOK_SECRET) {
    console.error("RAZORPAY_WEBHOOK_SECRET is not set; cannot sign. Skipping.");
    process.exitCode = 1;
    return;
  }

  const stamp = Date.now();
  const razorpayOrderId = `order_check_${stamp}`;
  const paymentId = `pay_check_${stamp}`;
  const eventId = `evt_check_${stamp}`;

  // A paid-pending order, as the checkout would have created it.
  const order = await prisma.order.create({
    data: {
      orderNumber: `RC-${stamp}`,
      customerName: "Webhook Route Test",
      customerPhone: "9876543210",
      address: "1 Route Road, Somewhere",
      city: "Bengaluru",
      state: "Karnataka",
      pincode: "560001",
      subtotal: 45000, shipping: 0, total: 45000,
      paymentMethod: "RAZORPAY",
      paymentStatus: "PENDING",
      orderStatus: "NEW",
      razorpayOrderId,
    },
  });

  const body = JSON.stringify({
    entity: "event",
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: razorpayOrderId,
          amount: 45000,
          currency: "INR",
          status: "captured",
        },
      },
    },
  });

  try {
    // --- 1. no signature ---------------------------------------------------
    const unsigned = await post(body, null, eventId);
    check("an unsigned webhook is refused", unsigned.status === 401, `status ${unsigned.status}`);

    // --- 2. wrong signature ------------------------------------------------
    const wrong = await post(body, "0".repeat(64), eventId);
    check("a wrongly signed webhook is refused", wrong.status === 401, `status ${wrong.status}`);

    const stillPending = await prisma.order.findUnique({ where: { id: order.id } });
    check(
      "a refused webhook changed nothing",
      stillPending?.paymentStatus === "PENDING",
      `paymentStatus=${stillPending?.paymentStatus}`,
    );

    // --- 3. tampered body, valid-shaped signature --------------------------
    const tampered = body.replace("45000", "1");
    const tamperedResult = await post(tampered, sign(body), eventId);
    check(
      "a body tampered after signing is refused",
      tamperedResult.status === 401,
      `status ${tamperedResult.status}`,
    );

    // --- 4. correctly signed capture ---------------------------------------
    const good = await post(body, sign(body), eventId);
    check(
      "a correctly signed capture is accepted",
      good.status === 200 && good.json.applied === true,
      `status ${good.status}, applied=${good.json.applied}`,
    );

    const paid = await prisma.order.findUnique({ where: { id: order.id } });
    check(
      "the order is now PAID",
      paid?.paymentStatus === "PAID",
      `paymentStatus=${paid?.paymentStatus}`,
    );
    check(
      "the payment id was recorded",
      paid?.razorpayPaymentId === paymentId,
      `razorpayPaymentId=${paid?.razorpayPaymentId}`,
    );

    const alerts = await prisma.notification.findMany({ where: { orderId: order.id } });
    check(
      "exactly one owner alert was queued",
      alerts.length === 1 && alerts[0].status === "PENDING",
      `alerts=${alerts.length}, status=${alerts[0]?.status}`,
    );

    const events = await prisma.paymentEvent.findMany({ where: { orderId: order.id } });
    check("exactly one payment event was recorded", events.length === 1, `events=${events.length}`);

    // --- 5. redelivery over HTTP -------------------------------------------
    const redelivery = await post(body, sign(body), eventId);
    check(
      "a redelivered capture is treated as a duplicate",
      redelivery.status === 200 && redelivery.json.duplicate === true,
      `status ${redelivery.status}, duplicate=${redelivery.json.duplicate}`,
    );

    const alertsAfter = await prisma.notification.count({ where: { orderId: order.id } });
    const eventsAfter = await prisma.paymentEvent.count({ where: { orderId: order.id } });
    check(
      "redelivery queued no second alert and recorded no second event",
      alertsAfter === 1 && eventsAfter === 1,
      `alerts=${alertsAfter}, events=${eventsAfter}`,
    );

    // --- 6. concurrent redelivery over HTTP --------------------------------
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => post(body, sign(body), eventId)),
    );
    const allAccepted = concurrent.every((r) => r.status === 200);
    const eventsFinal = await prisma.paymentEvent.count({ where: { orderId: order.id } });
    const alertsFinal = await prisma.notification.count({ where: { orderId: order.id } });
    check(
      "8 concurrent redeliveries are all accepted without error",
      allAccepted,
      concurrent.map((r) => r.status).join(","),
    );
    check(
      "still exactly one event and one alert after concurrency",
      eventsFinal === 1 && alertsFinal === 1,
      `events=${eventsFinal}, alerts=${alertsFinal}`,
    );

    // --- 7. a webhook for an unknown order --------------------------------
    const unknownBody = JSON.stringify({
      entity: "event",
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_x", order_id: "order_does_not_exist", amount: 1, currency: "INR" } } },
    });
    const unknown = await post(unknownBody, sign(unknownBody), `evt_unknown_${stamp}`);
    check(
      "a signed webhook for an unknown order is accepted and ignored (no retry loop)",
      unknown.status === 200,
      `status ${unknown.status}`,
    );

    // --- 8. failure event does not unpick a paid order ---------------------
    const failBody = JSON.stringify({
      entity: "event",
      event: "payment.failed",
      payload: {
        payment: {
          entity: { id: paymentId, order_id: razorpayOrderId, amount: 45000, currency: "INR", status: "failed" },
        },
      },
    });
    const failed = await post(failBody, sign(failBody), `evt_failed_${stamp}`);
    const afterFailure = await prisma.order.findUnique({ where: { id: order.id } });
    check(
      "a later failure event cannot unpick the paid order",
      failed.status === 200 && afterFailure?.paymentStatus === "PAID",
      `status ${failed.status}, paymentStatus=${afterFailure?.paymentStatus}`,
    );

    // --- 9. a browserless payment ------------------------------------------
    // The "customer closed the tab straight after paying" case. Asserted
    // explicitly rather than assumed, because this is the situation where ONLY
    // the webhook can complete the order - if it depended on any client state,
    // the order would be lost.
    const noBrowserRazorpayOrderId = `order_nobrowser_${stamp}`;
    const noBrowserOrder = await prisma.order.create({
      data: {
        orderNumber: `NB-${stamp}`,
        customerName: "No Browser Test",
        customerPhone: "9876543210",
        address: "1 Closed Tab Road, Somewhere",
        city: "Bengaluru",
        state: "Karnataka",
        pincode: "560001",
        subtotal: 10000, shipping: 0, total: 10000,
        paymentMethod: "RAZORPAY",
        paymentStatus: "PENDING",
        orderStatus: "NEW",
        razorpayOrderId: noBrowserRazorpayOrderId,
      },
    });

    const noBrowserBody = JSON.stringify({
      entity: "event",
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: `pay_nobrowser_${stamp}`,
            order_id: noBrowserRazorpayOrderId,
            amount: 10000,
            currency: "INR",
            status: "captured",
          },
        },
      },
    });

    // No cookie, no session, no referer: exactly what Razorpay's server sends.
    const noBrowserResponse = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Razorpay-Signature": sign(noBrowserBody),
        "x-razorpay-event-id": `evt_nobrowser_${stamp}`,
      },
      body: noBrowserBody,
    });

    const noBrowserSettled = await prisma.order.findUnique({ where: { id: noBrowserOrder.id } });
    const noBrowserAlerts = await prisma.notification.count({ where: { orderId: noBrowserOrder.id } });
    check(
      "a payment settles with no browser session at all (customer closed the tab)",
      noBrowserResponse.status === 200 && noBrowserSettled?.paymentStatus === "PAID",
      `status ${noBrowserResponse.status}, paymentStatus=${noBrowserSettled?.paymentStatus}`,
    );
    check(
      "and the owner alert is still queued",
      noBrowserAlerts === 1,
      `alerts=${noBrowserAlerts}`,
    );

    await prisma.order.delete({ where: { id: noBrowserOrder.id } });
  } finally {
    await prisma.order.delete({ where: { id: order.id } }).catch(() => {});
    await prisma.$disconnect();
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
