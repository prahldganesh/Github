/**
 * Admin refunds view (/admin/refunds).
 *
 * Refunds were already visible one order at a time, which is fine when you are
 * looking at a single order and useless when you want to ask "is anything
 * outstanding?". Two of the four refund states need a person:
 *
 *   PROCESSING - we sent the refund and never learned the outcome. The money may
 *                or may not have moved, so it must be reconciled rather than
 *                retried. This is the state a provider timeout leaves behind.
 *   FAILED     - a definite refusal, recorded with the reason.
 *
 * `?filter=attention` narrows to those two. The reconcile control reuses the
 * same server action the order page uses - not a copy of it.
 *
 * `searchParams` is a Promise in Next 16 and must be awaited.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth/guard";
import {
  listRefunds,
  listRefundsNeedingAttention,
  countRefundsByStatus,
} from "@/lib/payments/refunds";
import { reconcileRefundAction } from "@/app/admin/refund-actions";
import { StatusPill } from "@/components/admin/status-pill";
import { REFUND_STATUS_LABELS, REFUND_STATUS_TONES } from "@/lib/admin/labels";
import { formatPaise } from "@/lib/money";
import { formatDateTime, formatAge } from "@/lib/admin/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Refunds" };

type PageProps = { searchParams: Promise<{ filter?: string }> };

export default async function AdminRefundsPage({ searchParams }: PageProps) {
  await requireAdmin();
  const { filter } = await searchParams;
  const attentionOnly = filter === "attention";

  const [refunds, counts] = await Promise.all([
    attentionOnly ? listRefundsNeedingAttention() : listRefunds(),
    countRefundsByStatus(),
  ]);

  const processing = counts.PROCESSING ?? 0;
  const failed = counts.FAILED ?? 0;
  const succeeded = counts.SUCCEEDED ?? 0;
  const needsAttention = processing + failed;

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Refunds</h1>
        <span className="text-sm text-slate-500">
          {refunds.length} shown (most recent first)
        </span>
      </div>

      <p className="mt-2 max-w-3xl text-sm text-slate-600">
        Every refund attempt, kept as an audit trail — one row per attempt, never
        overwritten. A refund is only ever created for a <em>captured</em> payment,
        and never for more than was captured.
      </p>

      <section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <CountCard label="In progress" value={processing} tone={processing > 0 ? "warn" : "neutral"} hint="Outcome unknown — reconcile" />
        <CountCard label="Refunded" value={succeeded} tone="good" hint="Confirmed by the provider" />
        <CountCard label="Failed" value={failed} tone={failed > 0 ? "bad" : "neutral"} hint="Recorded with the reason" />
      </section>

      {needsAttention > 0 && !attentionOnly && (
        <p className="mt-6 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {needsAttention} refund{needsAttention === 1 ? "" : "s"} need attention.{" "}
          <Link href="/admin/refunds?filter=attention" className="font-medium underline">
            Show only those
          </Link>
        </p>
      )}

      {attentionOnly && (
        <p className="mt-6 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Showing only refunds that need a person.{" "}
          <Link href="/admin/refunds" className="underline">
            Show all refunds
          </Link>
        </p>
      )}

      {refunds.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed border-slate-300 p-10 text-center text-slate-600">
          {attentionOnly ? "Nothing needs attention." : "No refunds yet."}
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Order</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Provider refund</th>
                <th className="px-4 py-3">Tries</th>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Detail</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {refunds.map((refund) => (
                <tr key={refund.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    {refund.order ? (
                      <Link
                        href={`/admin/orders/${refund.order.id}`}
                        className="font-medium text-slate-900 hover:underline"
                      >
                        {refund.order.orderNumber}
                      </Link>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-medium">{formatPaise(refund.amount)}</td>
                  <td className="px-4 py-3">
                    <StatusPill
                      label={REFUND_STATUS_LABELS[refund.status]}
                      tone={REFUND_STATUS_TONES[refund.status]}
                    />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">
                    {refund.providerRefundId ?? <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{refund.attempts}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {refund.completedAt ? (
                      <span title={formatDateTime(refund.completedAt)}>
                        {formatAge(refund.completedAt)}
                      </span>
                    ) : (
                      <span title={formatDateTime(refund.createdAt)}>
                        started {formatAge(refund.createdAt)}
                      </span>
                    )}
                  </td>
                  <td className="max-w-xs px-4 py-3 text-xs text-red-800">
                    {refund.lastError ?? <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {/* Only the uncertain state offers this. A retry is never
                        offered here, because a timeout may already have moved
                        the money - reconciling first is the safe path. */}
                    {refund.status === "PROCESSING" && refund.order && (
                      <form action={reconcileRefundAction}>
                        <input type="hidden" name="orderId" value={refund.order.id} />
                        <button
                          type="submit"
                          className="whitespace-nowrap rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-50"
                        >
                          Reconcile
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-6 text-xs text-slate-500">
        Reconcile asks the payment provider what actually happened to a refund we
        could not confirm. It never resubmits, because a provider timeout may mean
        the money is already on its way.
      </p>
    </div>
  );
}

function CountCard({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number;
  tone: "good" | "warn" | "bad" | "neutral";
  hint: string;
}) {
  const border =
    tone === "bad" && value > 0
      ? "border-red-300 bg-red-50"
      : tone === "warn" && value > 0
        ? "border-amber-300 bg-amber-50"
        : tone === "good"
          ? "border-green-200 bg-green-50"
          : "border-slate-200 bg-white";

  return (
    <div className={`rounded-lg border p-4 ${border}`}>
      <p className="text-sm text-slate-600">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    </div>
  );
}
