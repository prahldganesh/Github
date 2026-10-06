import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration.
 *
 * MIGRATIONS USE A DIRECT CONNECTION, and that is the whole reason this file
 * reads two URLs.
 *
 * In production the app talks to Supabase's **transaction pooler** (port 6543),
 * which multiplexes many client connections onto few Postgres ones. That is the
 * right connection for application queries in a serverless environment, but it
 * CANNOT run migrations: a migration holds a session across many statements and
 * takes advisory locks, and a transaction-mode pooler may hand each statement a
 * different backend.
 *
 * So the CLI (migrate, studio, db push) uses `DIRECT_URL` - the session pooler
 * or direct connection - while the app's runtime client uses `DATABASE_URL`.
 *
 * Prisma 7 removed `directUrl` from the datasource block, which is why this
 * split now lives here rather than in `schema.prisma`.
 *
 * `DIRECT_URL` falls back to `DATABASE_URL` so that local development and CI
 * need only one variable; the two are the same database there.
 */
const migrationUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

if (!migrationUrl) {
  throw new Error(
    "Neither DIRECT_URL nor DATABASE_URL is set. The Prisma CLI needs one of them.",
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: migrationUrl,
  },
});
