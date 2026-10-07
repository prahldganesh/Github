/**
 * One customer's order history (/admin/customers/[phone]).
 *
 * There is no customer record, so there is nothing to edit here - this is the
 * orders placed by one phone number, which is the drill-down the customers list
 * needs to be useful.
 *
 * `params` is a Promise in Next 16 and must be awaited.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/guard";
import { listOrdersForCustomer } from "@/lib/orders/repository";
import { StatusPill } from "@/components/admin/status-pill";
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from "@/lib/orders/labels";
import { formatPaise } from "@/lib/money";
import { formatDateTime } from "@/lib/admin/format";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ phone: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { phone } = await params;
  return { title: `Customer ${phone}` };
}

export default async function AdminCustomerPage({ params }: PageProps) {
  const { phone } = await params;
  await requireAdmin();

  // Phones are stored normalised to ten digits. Reject anything else rather than
  // querying, so a hand-edited URL is a 404 and not a slow scan.
  if (!/^\d{10}$/.test(phone)) notFound();

  const orders = await listOrdersForCustomer(phone);
  if (orders.length === 0) notFound();

  // The most recent name and email this customer gave.
  const latest = orders[0];
  const totalPaise = orders
    .filter((order) => order.orderStatus !== "CANCELLED")
    .reduce((sum, order) => sum + order.total, 0);

  return (
    <div>
      <nav className="text-sm text-slate-500">
        <Link href="/admin/customers" className="hover:text-slate-900">
          Customers
        </Link>
        <span className="mx-2">/</span>
        <span className="text-slate-900">{latest.customerName}</span>
      </nav>

      <h1 className="mt-4 text-2xl font-bold tracking-tight">{latest.customerName}</h1>

      <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-sm text-slate-500">Phone</dt>
          <dd className="font-mono text-sm">{phone}</dd>
        </div>
        <div>
          <dt className="text-sm text-slate-500">Email</dt>
          <dd className="text-sm">{latest.customerEmail ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-sm text-slate-500">Orders · value</dt>
          <dd className="text-sm">
            {orders.length} · {formatPaise(totalPaise)}
            <span className="text-slate-400"> (excl. cancelled)</span>
          </dd>
        </div>
      </dl>

      <div className="mt-8 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Orders
        </h2>
        <span className="text-sm text-slate-500">{orders.length} total</span>
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Order</th>
              <th className="px-4 py-3">Placed</th>
              <th className="px-4 py-3 text-right">Total</th>
              <th className="px-4 py-3">Payment</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {orders.map((order) => (
              <tr key={order.id} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <Link
                    href={`/admin/orders/${order.id}`}
                    className="font-medium text-slate-900 hover:underline"
                  >
                    {order.orderNumber}
                  </Link>
                </td>
                <td className="px-4 py-3 text-slate-600">
                  {formatDateTime(order.createdAt)}
                </td>
                <td className="px-4 py-3 text-right font-medium">
                  {formatPaise(order.total)}
                </td>
                <td className="px-4 py-3">
                  <StatusPill
                    label={PAYMENT_STATUS_LABELS[order.paymentStatus]}
                    tone={
                      order.paymentStatus === "PAID"
                        ? "good"
                        : order.paymentStatus === "COD"
                          ? "neutral"
                          : "warn"
                    }
                  />
                </td>
                <td className="px-4 py-3">
                  <StatusPill
                    label={ORDER_STATUS_LABELS[order.orderStatus]}
                    tone={
                      order.orderStatus === "CANCELLED"
                        ? "bad"
                        : order.orderStatus === "DELIVERED"
                          ? "good"
                          : "neutral"
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
