/**
 * Prisma client singleton.
 *
 * Why a singleton matters here: Next.js dev mode hot-reloads modules on every
 * save. A naive `new PrismaClient()` at module scope creates a new pool each
 * time, and Postgres eventually refuses connections. Caching the instance on
 * `globalThis` survives the reload.
 *
 * Prisma 7 requires an explicit driver adapter. `@prisma/adapter-pg` is the
 * node-postgres adapter, which also gives us standard connection pooling the
 * app controls.
 *
 * ---------------------------------------------------------------------------
 * TIMEZONE - READ BEFORE CHANGING THE CONNECTION
 * ---------------------------------------------------------------------------
 * All timestamps are `timestamptz` (an instant, stored in UTC) which is the
 * correct type. The trap is the SESSION timezone. `pg` serializes a JS `Date`
 * parameter using its LOCAL representation without an offset, and Postgres then
 * interprets that naive string in the session timezone.
 *
 * Concretely, on this machine the server timezone is Asia/Kolkata (+05:30).
 * Writing `new Date("2026-06-01T09:20:55Z")` stored `2026-06-01T03:50:55Z` - the
 * instant shifted 5.5 hours into the past - while reading it back through the
 * same adapter returned the original value, so the corruption was invisible.
 *
 * The consequences were real and not cosmetic:
 *   - a retry scheduled an hour ahead landed in the past, so it fired
 *     immediately instead of backing off;
 *   - a worker lease 60s in the future looked already expired, letting a second
 *     worker claim the same job and SEND THE CUSTOMER A DUPLICATE MESSAGE;
 *   - every `created_at` / `updated_at` was 5.5 hours off.
 *
 * The fix is `options=-c timezone=UTC` on the connection: the session runs in
 * UTC, so a naive local string and a UTC instant agree. Set once here, it
 * applies to ORM writes, raw SQL, and parameters alike - which is why it
 * belongs at the connection rather than in each query.
 *
 * Supabase (production) sets UTC on its connection pooler by default, so this
 * is belt-and-braces there and load-bearing locally.
 */
import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/lib/env";
import { withUtcSession } from "./connection";

function createClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: withUtcSession(env().DATABASE_URL) });
  // No `log` option on purpose: Prisma would print its own error line in
  // addition to the structured log the caller already writes, so every failure
  // appeared three times. Errors are still thrown and handled by our logger.
  return new PrismaClient({ adapter });
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
