/**
 * Admin dashboard (/admin).
 *
 * A Server Component reading aggregate counts. It calls `requireAdmin()` itself
 * rather than trusting the layout, per the Next 16 security guidance: the
 * layout and the page render in parallel, so the page must not assume the
 * layout's guard ran first.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth/guard";
import { countOrders, countPaidButCancelledOrders } from "@/lib/orders/repository";
import { formatPaise } from "@/lib/money";
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from "@/lib/orders/labels";
import type { OrderStatus, PaymentStatus } from "@/generated/prisma/enums";

export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  await requireAdmin();
  const [counts, needsRefund] = await Promise.all([
    countOrders(),
    countPaidButCancelledOrders(),
  ]);

  const statusCount = (status: OrderStatus) =>
    counts.byStatus.find((row) => row.status === status)?.count ?? 0;
  const paymentCount = (status: PaymentStatus) =>
    counts.byPaymentStatus.find((row) => row.status === status)?.count ?? 0;

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>

      {/*
        The one thing on this page that costs real money if ignored: an order
        that was cancelled by the sweep and THEN paid. It is CANCELLED + PAID,
        which means the shop is holding money for an order it will not fulfil.
        Surfaced at the top, in red, rather than left to be discovered.
      */}
      {needsRefund > 0 && (
        <div
          role="alert"
          className="mt-6 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900"
        >
          <p className="font-semibold">
            {needsRefund} order{needsRefund === 1 ? "" : "s"} need
            {needsRefund === 1 ? "s" : ""} a refund.
          </p>
          <p className="mt-1">
            These were cancelled after being abandoned, and then the payment
            arrived. The customer has paid for an order that will not ship.
          </p>
          <Link href="/admin/orders?filter=refund" className="mt-2 inline-block font-medium underline">
            View them
          </Link>
        </div>
      )}

      <section className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard label="Total orders" value={String(counts.total)} />
        <SummaryCard label="Awaiting action" value={String(statusCount("NEW") + statusCount("CONFIRMED"))} />
        <SummaryCard
          label="Revenue (delivered)"
          value={formatPaise(counts.revenuePaiseIfDelivered)}
          hint="Only delivered orders are counted."
        />
      </section>

      <section className="mt-10 grid grid-cols-1 gap-8 sm:grid-cols-2">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Orders by status
          </h2>
          <ul className="mt-3 space-y-2 text-sm">
            {(Object.keys(ORDER_STATUS_LABELS) as OrderStatus[]).map((status) => (
              <li key={status} className="flex justify-between border-b border-slate-100 pb-2">
                <span className="text-slate-600">{ORDER_STATUS_LABELS[status]}</span>
                <span className="font-medium">{statusCount(status)}</span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Orders by payment
          </h2>
          <ul className="mt-3 space-y-2 text-sm">
            {(Object.keys(PAYMENT_STATUS_LABELS) as PaymentStatus[]).map((status) => (
              <li key={status} className="flex justify-between border-b border-slate-100 pb-2">
                <span className="text-slate-600">{PAYMENT_STATUS_LABELS[status]}</span>
                <span className="font-medium">{paymentCount(status)}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <Link
        href="/admin/orders"
        className="mt-10 inline-block rounded-md bg-slate-900 px-6 py-3 text-sm font-medium text-white"
      >
        View all orders
      </Link>
    </div>
  );
}

function SummaryCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}
