/**
 * A small coloured status chip, shared by the admin tables.
 *
 * Extracted from the orders page when the notification, refund and customer
 * views all needed the same thing. A Server Component - it renders no state.
 */

export type PillTone = "good" | "warn" | "bad" | "neutral";

const TONES: Record<PillTone, string> = {
  good: "bg-green-100 text-green-800",
  warn: "bg-amber-100 text-amber-800",
  bad: "bg-red-100 text-red-800",
  neutral: "bg-slate-100 text-slate-700",
};

export function StatusPill({ label, tone }: { label: string; tone: PillTone }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${TONES[tone]}`}>
      {label}
    </span>
  );
}
