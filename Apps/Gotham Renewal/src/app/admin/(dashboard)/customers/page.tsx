/**
 * Admin customers view (/admin/customers).
 *
 * There is no customer table - a customer exists because they placed an order.
 * This page aggregates the orders table by phone number, which validation
 * normalises to the last 10 digits, so `+91…`, `0…` and bare forms of one number
 * collapse into a single customer rather than appearing as three.
 *
 * What it answers that the orders list cannot: "who are my regulars?" - who
 * orders most, who is worth most, and who has not ordered in a while.
 *
 * The value shown excludes cancelled orders, because a cancelled order is not
 * revenue. The order count includes them, so a cancellation is visible in the
 * history rather than hidden. That asymmetry is deliberate and labelled.
 *
 * The guard is called here, not only in the layout. `searchParams` is a Promise
 * in Next 16.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth/guard";
import { listCustomers } from "@/lib/orders/repository";
import { formatPaise } from "@/lib/money";
import { formatDate, formatAge } from "@/lib/admin/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Customers" };

export default async function AdminCustomersPage() {
  await requireAdmin();
  const customers = await listCustomers();

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Customers</h1>
        <span className="text-sm text-slate-500">
          {customers.length} customer{customers.length === 1 ? "" : "s"}
        </span>
      </div>

      <p className="mt-2 max-w-3xl text-sm text-slate-600">
        Grouped by phone number. Value counts delivered and in-progress orders but
        not cancelled ones; the order count includes everything.
      </p>

      {customers.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed border-slate-300 p-10 text-center text-slate-600">
          No customers yet.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Phone</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3 text-right">Orders</th>
                <th className="px-4 py-3 text-right">Value</th>
                <th className="px-4 py-3">First order</th>
                <th className="px-4 py-3">Latest</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {customers.map((customer) => (
                <tr key={customer.phone} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/customers/${customer.phone}`}
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {customer.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">
                    {customer.phone}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {customer.email ?? <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right text-slate-700">
                    {customer.orderCount}
                  </td>
                  <td className="px-4 py-3 text-right font-medium">
                    {formatPaise(customer.valuePaise)}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    <span title={formatDate(customer.firstOrderAt)}>
                      {formatDate(customer.firstOrderAt)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    <span title={formatDate(customer.lastOrderAt)}>
                      {formatAge(customer.lastOrderAt)}
                    </span>
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
