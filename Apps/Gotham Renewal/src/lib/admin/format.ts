/**
 * Display formatting for the admin screens.
 *
 * The shop is in India and the owner reads these times in IST regardless of
 * where the server runs (the database stores UTC - ADR-0007), so the timezone is
 * pinned explicitly rather than left to the host's locale.
 *
 * Extracted because five admin pages now show timestamps, and five copies of the
 * same Intl options is five places for them to drift.
 */

const DATE_TIME = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Kolkata",
});

const DATE_ONLY = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeZone: "Asia/Kolkata",
});

/** e.g. "7 Oct 2026, 6:42 pm" in IST. */
export function formatDateTime(value: Date): string {
  return DATE_TIME.format(value);
}

/** e.g. "7 Oct 2026" in IST. */
export function formatDate(value: Date): string {
  return DATE_ONLY.format(value);
}

/** A short relative age, e.g. "3m ago". Useful for spotting stale jobs. */
export function formatAge(value: Date, now = new Date()): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - value.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
