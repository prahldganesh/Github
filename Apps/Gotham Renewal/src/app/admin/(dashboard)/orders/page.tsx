/**
 * Admin order list (/admin/orders).
 *
 * A table of recent orders with the status and payment state, each linking to
 * its detail page. The guard is called here too - see the layout comment for
 * why the page must not rely on the layout.
 *
 * `?filter=refund` narrows the list to the money-losing state: orders that were
 * cancelled after abandonment and then paid. The dashboard links here when any
 * exist. `searchParams` is a Promise in Next 16 and must be awaited.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth/guard";
import { listOrders, findPaidButCancelledOrders } from "@/lib/orders/repository";
import { formatPaise } from "@/lib/money";
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from "@/lib/orders/labels";
import { StatusPill } from "@/components/admin/status-pill";
import { formatDateTime } from "@/lib/admin/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Orders" };

type PageProps = { searchParams: Promise<{ filter?: string }> };

export default async function AdminOrdersPage({ searchParams }: PageProps) {
  await requireAdmin();
  const { filter } = await searchParams;
  const showingRefundsOnly = filter === "refund";

  const orders = showingRefundsOnly ? await findPaidButCancelledOrders() : await listOrders();

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Orders</h1>
        <span className="text-sm text-slate-500">
          {orders.length} shown (most recent first)
        </span>
      </div>

      {showingRefundsOnly && (
        <p className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          Showing only orders that need a refund: cancelled, then paid.{" "}
          <Link href="/admin/orders" className="underline">
            Show all orders
          </Link>
        </p>
      )}

      {orders.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed border-slate-300 p-10 text-center text-slate-600">
          {showingRefundsOnly ? "No orders need a refund." : "No orders yet."}
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Order</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Placed</th>
                <th className="px-4 py-3">Total</th>
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
                  <td className="px-4 py-3">
                    <span className="text-slate-900">{order.customerName}</span>
                    <span className="block text-xs text-slate-500">{order.customerPhone}</span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{formatDateTime(order.createdAt)}</td>
                  <td className="px-4 py-3 font-medium">{formatPaise(order.total)}</td>
                  <td className="px-4 py-3">
                    <StatusPill
                      label={PAYMENT_STATUS_LABELS[order.paymentStatus]}
                      tone={order.paymentStatus === "PAID" ? "good" : order.paymentStatus === "COD" ? "neutral" : "warn"}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill
                      label={ORDER_STATUS_LABELS[order.orderStatus]}
                      tone={order.orderStatus === "CANCELLED" ? "bad" : order.orderStatus === "DELIVERED" ? "good" : "neutral"}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
