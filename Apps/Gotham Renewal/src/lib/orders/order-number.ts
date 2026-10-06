/**
 * Order number formatting.
 *
 * Kept separate from the service so the notification templates and tests can
 * format a number without importing the whole order service (which pulls in
 * Prisma and is `server-only`).
 */

/** ("GR", 1042) -> "GR-1042". Zero-padded so numbers sort and read consistently. */
export function formatOrderNumber(prefix: string, sequence: number): string {
  return `${prefix}-${String(sequence).padStart(4, "0")}`;
}
