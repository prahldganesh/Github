/**
 * Order confirmation (/order-success/[orderId]).
 *
 * A Server Component that reads the order from the database by id. It does NOT
 * accept order details via the URL or from the client, so the page cannot be
 * used to display a fabricated order - only a real row renders.
 *
 * AUTHORISATION. The order id alone is not enough to view this page; a signed,
 * expiring, order-bound token is required (`?token=...`). An id is not a secret:
 * it appears in browser history, `Referer` headers, server logs and any proxy in
 * between. See lib/orders/access-token.ts for the reasoning.
 *
 * Every authorisation failure returns the same 404, whether the token is
 * missing, expired, forged, or valid-but-for-another-order. Distinguishing them
 * would confirm which order ids exist.
 *
 * `params` and `searchParams` are Promises in Next 16 and must be awaited.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { PaymentPendingNotice } from "@/components/payment-pending-notice";
import { env } from "@/lib/env";
import { verifyOrderAccessToken } from "@/lib/orders/access-token";
import { findOrderById } from "@/lib/orders/repository";
import { formatPaise } from "@/lib/money";
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from "@/lib/orders/labels";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Order confirmed", robots: { index: false } };

type PageProps = {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<{ token?: string }>;
};

export default async function OrderSuccessPage({ params, searchParams }: PageProps) {
  const { orderId } = await params;
  const { token } = await searchParams;

  // Guard the UUID shape before querying, so a garbage id is a 404 rather than
  // a database error surfacing as a 500.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId);
  if (!isUuid) notFound();

  // Authorise BEFORE reading the order, so an unauthorised request does not
  // even touch the row.
  if (!verifyOrderAccessToken(orderId, token, env().ADMIN_SESSION_SECRET)) {
    notFound();
  }

  const order = await findOrderById(orderId);
  if (!order) notFound();

  const isCod = order.paymentMethod === "COD";
  // Online payment that has not been confirmed by the webhook yet. Not an
  // error - the bank is still telling us - so the page says so honestly rather
  // than showing a bare "Pending" that reads as a failure.
  const awaitingPaymentConfirmation =
    order.paymentMethod === "RAZORPAY" && order.paymentStatus === "PENDING";

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-2xl px-6 py-12">
        <div className="rounded-lg border border-green-200 bg-green-50 p-6">
          <h1 className="text-2xl font-bold tracking-tight text-green-900">
            Thank you{order.customerName ? `, ${order.customerName.split(" ")[0]}` : ""}!
          </h1>
          <p className="mt-2 text-green-900">
            Your order <strong>{order.orderNumber}</strong> has been placed.
          </p>
          {isCod && (
            <p className="mt-1 text-sm text-green-800">
              Please keep {formatPaise(order.total)} ready in cash for delivery.
            </p>
          )}

          {/*
            An online payment whose webhook has not landed yet. The customer is
            looking at a page that says "pending" seconds after paying, which
            reads as a failure. They are told the truth - we are waiting for the
            bank's confirmation - and I check again in the background. Crucially
            this is only a DISPLAY concern: the page never marks itself paid, it
            only re-reads what the webhook wrote.
          */}
          {awaitingPaymentConfirmation && (
            <PaymentPendingNotice orderId={order.id} token={token ?? ""} />
          )}        </div>

        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Items
          </h2>
          <ul className="mt-3 divide-y divide-slate-200 border-y border-slate-200">
            {order.items.map((item) => (
              <li key={item.id} className="flex justify-between py-3">
                <span>
                  {item.productName}
                  <span className="ml-2 text-sm text-slate-500">
                    {item.quantity} × {formatPaise(item.unitPrice)}
                  </span>
                </span>
                <span className="font-medium">{formatPaise(item.total)}</span>
              </li>
            ))}
          </ul>

          <dl className="mt-4 space-y-2 text-sm">
            <Row label="Subtotal" value={formatPaise(order.subtotal)} />
            <Row label="Shipping" value={order.shipping === 0 ? "Free" : formatPaise(order.shipping)} />
            <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold">
              <dt>Total</dt>
              <dd>{formatPaise(order.total)}</dd>
            </div>
          </dl>
        </section>

        <section className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Delivery to
            </h2>
            <address className="mt-2 text-sm not-italic text-slate-700">
              {order.customerName}
              <br />
              {order.address}
              <br />
              {order.city}, {order.state} {order.pincode}
              <br />
              {order.customerPhone}
            </address>
          </div>

          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Order details
            </h2>
            <dl className="mt-2 space-y-1 text-sm text-slate-700">
              <Row label="Placed" value={formatDate(order.createdAt)} />
              <Row label="Payment" value={PAYMENT_STATUS_LABELS[order.paymentStatus]} />
              <Row label="Status" value={ORDER_STATUS_LABELS[order.orderStatus]} />
            </dl>
          </div>
        </section>

        <Link href="/products" className="mt-10 inline-block text-sm text-slate-600 underline">
          Continue shopping
        </Link>
      </main>
      <SiteFooter />
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-slate-500">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  }).format(date);
}
