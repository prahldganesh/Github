/**
 * Admin outbox view (/admin/notifications).
 *
 * WHY THIS SCREEN EXISTS. Notifications are delivered by an outbox: an order
 * commits a row saying "an alert is owed", and a worker sends it afterwards. That
 * design buys durability - a crash cannot lose an alert - but until now it also
 * bought invisibility. A failed notification was only discoverable by reading the
 * database directly, so "the owner never got told about an order" was a silent
 * failure.
 *
 * This page is the answer to that: every queued, sent and failed notification,
 * with the reason it failed and a link to the order it concerned.
 *
 * `?filter=failed` narrows to the ones a person must act on - typically a Meta
 * template that has not been approved yet, or a token that expired.
 *
 * The guard is called here, not only in the layout: the layout and page render in
 * parallel, so the page must not assume the layout's check ran first.
 * `searchParams` is a Promise in Next 16 and must be awaited.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth/guard";
import {
  listNotifications,
  listFailedNotifications,
  countNotificationsByStatus,
} from "@/lib/notifications/outbox";
import { StatusPill } from "@/components/admin/status-pill";
import {
  NOTIFICATION_STATUS_LABELS,
  NOTIFICATION_STATUS_TONES,
  NOTIFICATION_TYPE_LABELS,
} from "@/lib/admin/labels";
import { formatDateTime, formatAge } from "@/lib/admin/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Notifications" };

type PageProps = { searchParams: Promise<{ filter?: string }> };

export default async function AdminNotificationsPage({ searchParams }: PageProps) {
  await requireAdmin();
  const { filter } = await searchParams;
  const failedOnly = filter === "failed";

  const [notifications, counts] = await Promise.all([
    failedOnly ? listFailedNotifications() : listNotifications(),
    countNotificationsByStatus(),
  ]);

  const pending = counts.PENDING ?? 0;
  const sent = counts.SENT ?? 0;
  const failed = counts.FAILED ?? 0;

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
        <span className="text-sm text-slate-500">
          {notifications.length} shown (most recent first)
        </span>
      </div>

      <p className="mt-2 max-w-3xl text-sm text-slate-600">
        Every alert this shop owes. A notification is written in the same
        transaction as its order, then sent afterwards — so if this page shows a
        pending or failed alert, the <em>order is still safe</em>. Only the
        message is outstanding.
      </p>

      {/* Counts first: the owner should see at a glance whether anything is stuck. */}
      <section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <CountCard label="Pending" value={pending} tone="neutral" hint="Queued or retrying" />
        <CountCard label="Sent" value={sent} tone="good" hint="Delivered to Meta" />
        <CountCard label="Failed" value={failed} tone={failed > 0 ? "bad" : "neutral"} hint="Needs attention" />
      </section>

      {failed > 0 && !failedOnly && (
        <p className="mt-6 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          {failed} notification{failed === 1 ? "" : "s"} failed.{" "}
          <Link href="/admin/notifications?filter=failed" className="font-medium underline">
            Show only failures
          </Link>
        </p>
      )}

      {failedOnly && (
        <p className="mt-6 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          Showing only failures.{" "}
          <Link href="/admin/notifications" className="underline">
            Show all notifications
          </Link>
        </p>
      )}

      {notifications.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed border-slate-300 p-10 text-center text-slate-600">
          {failedOnly ? "Nothing has failed." : "No notifications yet."}
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Order</th>
                <th className="px-4 py-3">What</th>
                <th className="px-4 py-3">To</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Tries</th>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {notifications.map((notification) => (
                <tr key={notification.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    {notification.order ? (
                      <Link
                        href={`/admin/orders/${notification.order.id}`}
                        className="font-medium text-slate-900 hover:underline"
                      >
                        {notification.order.orderNumber}
                      </Link>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {NOTIFICATION_TYPE_LABELS[notification.type]}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">
                    {notification.recipient}
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill
                      label={NOTIFICATION_STATUS_LABELS[notification.status]}
                      tone={NOTIFICATION_STATUS_TONES[notification.status]}
                    />
                  </td>
                  <td className="px-4 py-3 text-slate-600">{notification.attempts}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {notification.sentAt ? (
                      <span title={formatDateTime(notification.sentAt)}>Sent {formatAge(notification.sentAt)}</span>
                    ) : notification.status === "FAILED" ? (
                      <span title={formatDateTime(notification.updatedAt)}>
                        Failed {formatAge(notification.updatedAt)}
                      </span>
                    ) : (
                      <span title={formatDateTime(notification.nextAttemptAt)}>
                        Retry {formatAge(notification.nextAttemptAt)}
                      </span>
                    )}
                  </td>
                  <td className="max-w-xs px-4 py-3 text-xs text-red-800">
                    {notification.lastError ?? <span className="text-slate-400">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-6 text-xs text-slate-500">
        Alerts are attempted immediately after the order is placed. The daily cron
        is a retry safety net for anything that could not be delivered at the time
        — for example while the Meta template is awaiting approval.
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
  tone: "good" | "bad" | "neutral";
  hint: string;
}) {
  const border =
    tone === "bad" && value > 0
      ? "border-red-300 bg-red-50"
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
