/**
 * Admin order detail (/admin/orders/[id]).
 *
 * Everything the shop needs to fulfil one order: who it is for, where it goes,
 * what was bought (with the snapshot prices the customer actually agreed to),
 * the money, and the payment and order statuses with controls to advance them.
 *
 * The status controls offer only the transitions the state machine allows, so
 * the UI cannot present an illegal action - and the server refuses one anyway
 * if it is forged.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/guard";
import { refundEligibility, type RefundProblem } from "@/lib/payments/refund-eligibility";
import { latestRefundForOrder } from "@/lib/payments/refunds";
import { issueRefundAction, reconcileRefundAction } from "@/app/admin/refund-actions";
import { updateOrderStatusAction } from "@/app/admin/actions";
import { findOrderById } from "@/lib/orders/repository";
import { allowedNextStatuses } from "@/lib/orders/status";
import { formatPaise } from "@/lib/money";
import {
  ORDER_STATUS_LABELS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
} from "@/lib/orders/labels";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    error?: string;
    updated?: string;
    refunded?: string;
    reconciled?: string;
  }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  return { title: `Order ${id.slice(0, 8)}` };
}

export default async function AdminOrderDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { error, updated, refunded, reconciled } = await searchParams;
  await requireAdmin();

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  if (!isUuid) notFound();

  const order = await findOrderById(id);
  if (!order) notFound();

  const nextStatuses = allowedNextStatuses(order.orderStatus);

  // Refund state. Eligibility is computed HERE, on the server, from the row we
  // just read - the button is only shown when the server says it is allowed, and
  // the action re-checks anyway. Hiding a control is not a control.
  const ineligibility: RefundProblem | null = refundEligibility(order);
  const latestRefund = await latestRefundForOrder(order.id);

  return (
    <div>
      <nav className="text-sm text-slate-500">
        <Link href="/admin/orders" className="hover:text-slate-900">
          Orders
        </Link>
        <span className="mx-2">/</span>
        <span className="text-slate-900">{order.orderNumber}</span>
      </nav>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{order.orderNumber}</h1>
        <StatusBadge label={ORDER_STATUS_LABELS[order.orderStatus]} />
        <StatusBadge label={PAYMENT_STATUS_LABELS[order.paymentStatus]} />
      </div>

      {error && (
        <p role="alert" className="mt-6 rounded-md bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}
      {updated && (
        <p role="status" className="mt-6 rounded-md bg-green-50 p-3 text-sm text-green-800">
          Order updated to {updated.toLowerCase()}.
        </p>
      )}
      {refunded && (
        <p role="status" className="mt-6 rounded-md bg-green-50 p-3 text-sm text-green-800">
          Refund issued. Provider refund id: <span className="font-mono">{refunded}</span>
        </p>
      )}
      {reconciled && (
        <p role="status" className="mt-6 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          Reconciliation: {reconciled}
        </p>
      )}

      {/*
        The refund panel. Shown only when the server says this order is holding
        the customer's money (or when an attempt exists and its outcome is
        unknown). The wording avoids implying the money has moved: a refund is a
        request until the provider confirms it.
      */}
      {ineligibility === null || latestRefund ? (
        <section
          className={`mt-6 rounded-lg border p-5 ${
            ineligibility === null
              ? "border-red-300 bg-red-50"
              : "border-slate-200 bg-white"
          }`}
        >
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
            Refund
          </h2>

          {latestRefund && (
            <dl className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-500">Status</dt>
                <dd className="font-medium">{latestRefund.status}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Amount</dt>
                <dd>{formatPaise(latestRefund.amount)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Provider refund</dt>
                <dd className="font-mono text-xs">
                  {latestRefund.providerRefundId ?? "—"}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Attempts</dt>
                <dd>{latestRefund.attempts}</dd>
              </div>
              {latestRefund.lastError && (
                <div className="flex justify-between gap-4">
                  <dt className="shrink-0 text-slate-500">Last error</dt>
                  <dd className="text-right text-xs text-red-800">{latestRefund.lastError}</dd>
                </div>
              )}
            </dl>
          )}

          {ineligibility === null && latestRefund?.status !== "SUCCEEDED" && (
            <p className="mt-3 text-sm text-red-900">
              This order was cancelled after being paid, so the customer&apos;s money
              must be returned.
              {latestRefund?.status === "PROCESSING"
                ? " A refund was sent but the provider has not confirmed it. Reconcile before retrying - the money may already be on its way."
                : " This is a full refund of the captured amount."}
            </p>
          )}

          {latestRefund?.status === "SUCCEEDED" && (
            <p className="mt-3 text-sm text-green-900">
              Refunded on{" "}
              {latestRefund.completedAt
                ? new Intl.DateTimeFormat("en-IN", {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone: "Asia/Kolkata",
                  }).format(latestRefund.completedAt)
                : "an earlier date"}
              . The provider may still take a few days to reach the customer&apos;s bank.
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {ineligibility === null && latestRefund?.status !== "SUCCEEDED" && (
              <form action={issueRefundAction}>
                <input type="hidden" name="orderId" value={order.id} />
                <button
                  type="submit"
                  className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800"
                >
                  {latestRefund?.status === "FAILED"
                    ? "Retry refund"
                    : "Issue full refund"}
                </button>
              </form>
            )}

            {latestRefund &&
              (latestRefund.status === "PROCESSING" || latestRefund.status === "PENDING") && (
                <form action={reconcileRefundAction}>
                  <input type="hidden" name="orderId" value={order.id} />
                  <button
                    type="submit"
                    className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50"
                  >
                    Reconcile with Razorpay
                  </button>
                </form>
              )}
          </div>

          <p className="mt-3 text-xs text-slate-500">
            Refunds are issued to the original payment method. A refund can only be
            created for a captured payment, and never more than was captured.
          </p>
        </section>
      ) : null}

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <section className="rounded-lg border border-slate-200 bg-white">
            <h2 className="border-b border-slate-100 px-5 py-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Items
            </h2>
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2">Product</th>
                  <th className="px-5 py-2 text-right">Qty</th>
                  <th className="px-5 py-2 text-right">Unit</th>
                  <th className="px-5 py-2 text-right">Line total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {order.items.map((item) => (
                  <tr key={item.id}>
                    <td className="px-5 py-3">
                      {item.productName}
                      <span className="mt-0.5 block text-xs text-slate-400">
                        Snapshot of the price at purchase
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right">{item.quantity}</td>
                    <td className="px-5 py-3 text-right">{formatPaise(item.unitPrice)}</td>
                    <td className="px-5 py-3 text-right font-medium">{formatPaise(item.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <dl className="space-y-2 border-t border-slate-100 px-5 py-4 text-sm">
              <MoneyRow label="Subtotal" value={formatPaise(order.subtotal)} />
              <MoneyRow
                label="Shipping"
                value={order.shipping === 0 ? "Free" : formatPaise(order.shipping)}
              />
              <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold">
                <dt>Total</dt>
                <dd>{formatPaise(order.total)}</dd>
              </div>
            </dl>
          </section>
        </div>

        <div className="space-y-6">
          <section className="rounded-lg border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Customer
            </h2>
            <dl className="mt-3 space-y-2 text-sm">
              <Detail label="Name">{order.customerName}</Detail>
              <Detail label="Phone">
                <a href={`tel:${order.customerPhone}`} className="underline">
                  {order.customerPhone}
                </a>
              </Detail>
              <Detail label="Email">{order.customerEmail ?? "—"}</Detail>
            </dl>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Delivery address
            </h2>
            <address className="mt-3 text-sm not-italic text-slate-700">
              {order.address}
              <br />
              {order.city}, {order.state} {order.pincode}
            </address>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Payment
            </h2>
            <dl className="mt-3 space-y-2 text-sm">
              <Detail label="Method">{PAYMENT_METHOD_LABELS[order.paymentMethod]}</Detail>
              <Detail label="Status">{PAYMENT_STATUS_LABELS[order.paymentStatus]}</Detail>
              <Detail label="Razorpay order">{order.razorpayOrderId ?? "—"}</Detail>
              <Detail label="Razorpay payment">{order.razorpayPaymentId ?? "—"}</Detail>
            </dl>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Update status
            </h2>

            {nextStatuses.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">
                This order is {ORDER_STATUS_LABELS[order.orderStatus].toLowerCase()} and cannot
                be changed.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {nextStatuses.map((status) => (
                  <li key={status}>
                    <form action={updateOrderStatusAction} className="flex items-center gap-2">
                      <input type="hidden" name="orderId" value={order.id} />
                      <input type="hidden" name="status" value={status} />
                      <button
                        type="submit"
                        className={`w-full rounded-md px-4 py-2 text-sm font-medium ${
                          status === "CANCELLED"
                            ? "border border-red-300 text-red-700 hover:bg-red-50"
                            : "bg-slate-900 text-white hover:bg-slate-800"
                        }`}
                      >
                        Mark as {ORDER_STATUS_LABELS[status].toLowerCase()}
                        {status === "CANCELLED" ? " (returns stock)" : ""}
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}

            <p className="mt-4 text-xs text-slate-400">
              Placed {formatDate(order.createdAt)}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

function MoneyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-slate-600">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right text-slate-900">{children}</dd>
    </div>
  );
}

function StatusBadge({ label }: { label: string }) {
  return (
    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
      {label}
    </span>
  );
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  }).format(date);
}
