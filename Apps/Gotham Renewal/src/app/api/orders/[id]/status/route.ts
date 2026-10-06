/**
 * Poll an order's payment status.
 *
 * GET /api/orders/[id]/status?token=...
 *
 * Used by the confirmation page to notice when a Razorpay webhook has landed.
 * It returns ONLY the payment and order status - never the customer's name,
 * address or phone - so a leaked confirmation link exposes as little as
 * possible.
 *
 * Authorised by the same signed, expiring, order-bound token that guards the
 * confirmation page. Without it this endpoint would be an order-status oracle.
 *
 * This endpoint is READ-ONLY by design. There is deliberately no counterpart
 * that lets a browser report "payment succeeded": only the signed webhook may
 * change payment state (ADR-0002).
 */
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { verifyOrderAccessToken } from "@/lib/orders/access-token";
import { findOrderById } from "@/lib/orders/repository";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const token = request.nextUrl.searchParams.get("token");

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  if (!isUuid) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // The same 404 for every authorisation failure, so this cannot be used to
  // probe which order ids exist.
  if (!verifyOrderAccessToken(id, token, env().ADMIN_SESSION_SECRET)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const order = await findOrderById(id);
  if (!order) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Status fields only. No customer PII.
  return NextResponse.json(
    { paymentStatus: order.paymentStatus, orderStatus: order.orderStatus },
    { headers: { "Cache-Control": "no-store" } },
  );
}
