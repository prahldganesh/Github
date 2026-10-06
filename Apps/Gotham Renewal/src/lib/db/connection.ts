/**
 * Connection-string helpers for PostgreSQL.
 *
 * This module has NO `server-only` import, deliberately: the app's db client
 * uses it, and so do the CLI scripts and the seed, which run outside Next and
 * where `server-only` would throw. One definition, used everywhere, so a script
 * cannot accidentally connect with a different session timezone than the app.
 */

/**
 * Force the session timezone to UTC on a connection string.
 *
 * WHY THIS IS LOAD-BEARING, not a nicety. `pg` serializes a JS `Date` parameter
 * using its LOCAL representation without an offset, and Postgres then reads that
 * naive string in the SESSION timezone. With a non-UTC session (Asia/Kolkata on
 * this machine, +05:30) an instant is silently shifted:
 *
 *     new Date("2026-06-01T09:20:55Z")  ->  stored as  2026-06-01T03:50:55Z
 *
 * and reading it back through the same adapter returns the original value, so
 * the corruption is invisible to round-trip tests. It bit us for real:
 * retry backoff fired immediately instead of waiting, a 60-second worker lease
 * looked already-expired (allowing a duplicate WhatsApp message), and every
 * created_at/updated_at was 5.5 hours off.
 *
 * Setting the session to UTC makes a naive local string and a UTC instant agree.
 *
 * ---------------------------------------------------------------------------
 * PRODUCTION CAVEAT - READ BEFORE CHANGING
 * ---------------------------------------------------------------------------
 * This is applied as a libpq startup parameter (`options=-c timezone=UTC`).
 * Supabase's Postgres is UTC by default, so it is redundant there; it exists for
 * local development and any host with a non-UTC default. Connection poolers
 * forward `options` (PgBouncer lists it as a known startup parameter), but this
 * has NOT been verified against Supabase's Supavisor from here. If the app
 * cannot connect in production and the error names `options` or an unsupported
 * startup parameter, set `DB_SESSION_UTC=false` in the environment - that is
 * exactly why the switch exists. Verifying this is on the deploy checklist.
 */
export function withUtcSession(connectionString: string): string {
  if (process.env.DB_SESSION_UTC === "false") return connectionString;

  const separator = connectionString.includes("?") ? "&" : "?";
  return `${connectionString}${separator}options=-c%20timezone%3DUTC`;
}
