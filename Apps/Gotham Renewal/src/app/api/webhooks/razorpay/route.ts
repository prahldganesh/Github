/**
 * Razorpay webhook - the authoritative payment signal.
 *
 * POST /api/webhooks/razorpay
 *
 * This endpoint is the ONLY thing that may mark an order PAID. The browser
 * callback that Razorpay Checkout fires is user experience; it can be spoofed,
 * replayed, or never arrive. This request carries an HMAC signature that only
 * Razorpay and this server can produce (ADR-0002).
 *
 * The sequence, and why each step is where it is:
 *
 *   1. Read the RAW body (`await request.text()`), never `request.json()`. The
 *      signature covers the exact bytes; parsing and re-serializing changes key
 *      order and whitespace, and the digest stops matching.
 *   2. Verify the HMAC in constant time, and refuse before touching the
 *      database. An unsigned request must not be able to cause a query.
 *   3. Derive a stable event key and record it with
 *      `INSERT ... ON CONFLICT DO NOTHING`. The unique constraint decides
 *      duplicates, not application logic, so concurrent redeliveries cannot
 *      both apply (ADR-0006, check:webhook-idempotency).
 *   4. In the SAME transaction: record the event, apply the payment decision,
 *      and - on a capture - enqueue the owner's alert via the outbox.
 *   5. AFTER the commit, do nothing else. The worker sends the alert. Meta
 *      being down cannot fail or roll back a payment.
 *
 * Responses: 200 for anything we have accepted, including duplicates and events
 * we do not act on, because a non-2xx makes Razorpay retry forever. 400 for a
 * body we cannot use, 401 for a bad signature, 503 when we cannot persist -
 * which is the one case where a retry is genuinely wanted.
 */
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { razorpayConfigured } from "@/lib/env";
import { logger, errorFields } from "@/lib/logger";
import { verifyWebhook, parseWebhookEvent, deriveEventKey } from "@/lib/payments/razorpay/webhook";
import type { RazorpayConfig } from "@/lib/payments/razorpay/types";
import { recordPaymentEvent } from "@/lib/payments/events";
import { decidePaymentAction } from "@/lib/payments/decision";
import { enqueueOrderAlert } from "@/lib/orders/service";
import {
  findOrderByRazorpayOrderId,
  markOrderPaid,
} from "@/lib/orders/repository";
import type { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";
// The handler does one transaction and returns. Nothing in it waits on a
// third party, so it should never need more than a few seconds.
export const maxDuration = 30;

function config(): RazorpayConfig {
  const e = process.env;
  return {
    keyId: e.RAZORPAY_KEY_ID ?? "",
    keySecret: e.RAZORPAY_KEY_SECRET ?? "",
    webhookSecret: e.RAZORPAY_WEBHOOK_SECRET ?? "",
  };
}

export async function POST(request: NextRequest) {
  // --- 1. raw body ---------------------------------------------------------
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: "Unreadable body" }, { status: 400 });
  }

  if (!razorpayConfigured()) {
    // Cannot verify anything without the secret. Refuse rather than trusting.
    logger.error("razorpay webhook received but razorpay is not configured");
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }

  // --- 2. verify the signature, before any database work -------------------
  const verification = verifyWebhook(rawBody, request.headers, config().webhookSecret);
  if (!verification.ok) {
    logger.warn("razorpay webhook signature rejected", { reason: verification.reason });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // --- parse ---------------------------------------------------------------
  const event = parseWebhookEvent(rawBody);
  const eventKey = deriveEventKey(request.headers, rawBody);

  if (!event.orderId) {
    // Nothing identifies a Razorpay order, so there is nothing to apply. This
    // is a body we cannot use; a 400 tells Razorpay not to keep retrying it.
    logger.warn("razorpay webhook without an order id", { event: event.event, eventKey });
    return NextResponse.json({ error: "No order reference" }, { status: 400 });
  }

  // --- 3. find our order ---------------------------------------------------
  const order = await findOrderByRazorpayOrderId(event.orderId);
  if (!order) {
    // A signed event for an order we do not have. Returning 200 stops the
    // retries: the event is not ours to apply, and retrying will not change
    // that. Logged so a genuine mismatch is visible.
    logger.warn("razorpay webhook for an unknown order", {
      razorpayOrderId: event.orderId,
      event: event.event,
    });
    return NextResponse.json({ received: true, matched: false });
  }

  const decision = decidePaymentAction(order.paymentStatus, event.event);

  // --- 4. one transaction: record the event and apply the decision ---------
  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const recorded = await recordPaymentEvent(tx, {
        orderId: order.id,
        provider: "RAZORPAY",
        providerEventId: eventKey,
        eventType: event.event,
        payload: JSON.parse(rawBody) as Prisma.InputJsonValue,
      });

      if (recorded.outcome === "duplicate") {
        // Already processed by an earlier (or concurrent) delivery. Nothing to
        // do; 200 below so Razorpay stops.
        return { applied: false, duplicate: true, action: decision.action };
      }

      switch (decision.action) {
        case "mark-paid": {
          await markOrderPaid(tx, order.id, event.paymentId);
          // The alert is enqueued here, inside the transaction, so "the order
          // is paid" and "the owner must be told" commit together. The unique
          // (order_id, type) constraint means a redelivered capture cannot queue
          // a second message.
          await enqueueOrderAlert(tx, {
            orderId: order.id,
            orderNumber: order.orderNumber,
            customerName: order.customerName,
            customerPhone: order.customerPhone,
            total: order.total,
            paymentStatus: "PAID",
          });
          return { applied: true, duplicate: false, action: decision.action };
        }

        case "mark-refunded": {
          await tx.order.update({
            where: { id: order.id },
            data: { paymentStatus: "REFUNDED" },
          });
          return { applied: true, duplicate: false, action: decision.action };
        }

        case "mark-failed": {
          await tx.order.update({
            where: { id: order.id },
            data: { paymentStatus: "FAILED" },
          });
          return { applied: true, duplicate: false, action: decision.action };
        }

        case "ignore": {
          // Recorded for audit; no order change. Returned as applied:false so
          // the log is honest about what happened.
          return { applied: false, duplicate: false, action: decision.action };
        }
      }
    });

    logger.info("razorpay webhook processed", {
      orderId: order.id,
      orderNumber: order.orderNumber,
      event: event.event,
      action: outcome.action,
      applied: outcome.applied,
      duplicate: outcome.duplicate,
    });

    return NextResponse.json({
      received: true,
      applied: outcome.applied,
      duplicate: outcome.duplicate,
    });
  } catch (error) {
    // We could not persist. This is the one case where a retry is wanted, so
    // the response must NOT be a 2xx.
    logger.error("razorpay webhook could not be processed", {
      orderId: order.id,
      event: event.event,
      ...errorFields(error),
    });
    return NextResponse.json({ error: "Processing failed" }, { status: 503 });
  }
}
