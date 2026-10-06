/**
 * Database verification - run this against LOCAL before trusting it against
 * Supabase, then run it against Supabase after switching.
 *
 * It checks the things that are silent when wrong. A connection that "works"
 * can still store every timestamp 5.5 hours off, and every round-trip through
 * the ORM will look perfectly fine while doing it. This script caught that bug
 * once by comparing against real UTC instead of against itself.
 *
 * Run: npm run check:database
 *
 * Exits non-zero on any failure, so it is usable as a deploy gate.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { withUtcSession } from "../src/lib/db/connection";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

// Report WHERE we are connected without printing the password.
function describeTarget(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
  } catch {
    return "(unparseable connection string)";
  }
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: withUtcSession(url) }),
});

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = "") {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log(`Target: ${describeTarget(url!)}\n`);

  // --- 1. the session timezone -------------------------------------------
  // The single most important check. A non-UTC session silently shifts every
  // instant written as a JS Date.
  //
  // `current_setting`, not `SHOW timezone`: SHOW returns a column named
  // "TimeZone" whose casing is easy to get wrong, and a mis-read here would
  // report `undefined` and look like a real failure.
  const tz = await prisma.$queryRaw<Array<{ tz: string }>>`
    SELECT current_setting('TimeZone') AS tz
  `;
  const sessionTz = tz[0]?.tz;
  check(
    "the session timezone is UTC",
    sessionTz === "UTC",
    sessionTz === "UTC"
      ? sessionTz
      : `${sessionTz} — timestamps WILL be shifted. See src/lib/db/connection.ts`,
  );

  // --- 2. timestamp round-trip against REAL UTC --------------------------
  // Not a round-trip through the ORM (that hides the bug). This asks Postgres
  // what instant it actually received, rendered in UTC, and compares it to the
  // instant we intended. An offset here is the 5.5-hour class of bug.
  const intended = new Date();
  const rows = await prisma.$queryRaw<Array<{ stored: string }>>`
    SELECT to_char(${intended}::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS stored
  `;
  const storedUtc = rows[0].stored;
  const intendedUtc = intended.toISOString().slice(0, 19);
  check(
    "a JS Date is stored as the instant we intended (UTC)",
    storedUtc === intendedUtc,
    storedUtc === intendedUtc
      ? storedUtc
      : `intended ${intendedUtc}Z, Postgres received ${storedUtc}Z`,
  );

  // --- 3. the schema is fully migrated -----------------------------------
  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  const tableNames = tables.map((t) => t.table_name);
  const expectedTables = [
    "counters",
    "notifications",
    "order_items",
    "orders",
    "payment_events",
    "products",
    "refunds",
  ];
  const missingTables = expectedTables.filter((t) => !tableNames.includes(t));
  check(
    "all 7 tables exist",
    missingTables.length === 0,
    missingTables.length === 0 ? expectedTables.join(", ") : `missing: ${missingTables.join(", ")}`,
  );

  const enums = await prisma.$queryRaw<Array<{ typname: string }>>`
    SELECT typname FROM pg_type WHERE typtype = 'e' ORDER BY typname
  `;
  const enumNames = enums.map((e) => e.typname);
  const expectedEnums = [
    "NotificationChannel",
    "NotificationStatus",
    "NotificationType",
    "OrderStatus",
    "PaymentMethod",
    "PaymentStatus",
    "RefundStatus",
  ];
  const missingEnums = expectedEnums.filter((e) => !enumNames.includes(e));
  check(
    "all 7 enums exist",
    missingEnums.length === 0,
    missingEnums.length === 0 ? expectedEnums.join(", ") : `missing: ${missingEnums.join(", ")}`,
  );

  // --- 4. migrations recorded --------------------------------------------
  const applied = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*)::bigint AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL
  `;
  const appliedCount = Number(applied[0].count);
  check("migrations have been applied", appliedCount >= 5, `${appliedCount} applied`);

  // --- 5. the constraints the guarantees rest on -------------------------
  const constraints = await prisma.$queryRaw<Array<{ conname: string; tbl: string }>>`
    SELECT indexname AS conname, tablename AS tbl FROM pg_indexes
    WHERE tablename IN ('payment_events','notifications','refunds','products','orders')
      AND indexdef LIKE '%UNIQUE%'
  `;
  const hasUnique = (table: string, fragment: string) =>
    constraints.some((c) => c.tbl === table && c.conname.includes(fragment));

  check(
    "payment_events is unique on (provider, provider_event_id) — webhook idempotency",
    hasUnique("payment_events", "provider_provider_event_id"),
    constraints
      .filter((c) => c.tbl === "payment_events")
      .map((c) => c.conname)
      .join(", "),
  );
  check(
    "refunds is unique on idempotency_key — refund idempotency",
    hasUnique("refunds", "idempotency_key"),
    constraints.filter((c) => c.tbl === "refunds").map((c) => c.conname).join(", "),
  );
  check(
    "notifications is unique on (order_id, type) — one alert per order",
    hasUnique("notifications", "order_id_type"),
    constraints.filter((c) => c.tbl === "notifications").map((c) => c.conname).join(", "),
  );
  check(
    "orders.order_number is unique — no duplicate order numbers",
    hasUnique("orders", "order_number"),
    constraints.filter((c) => c.tbl === "orders").map((c) => c.conname).join(", "),
  );

  // --- 6. products.version exists (optimistic concurrency) ---------------
  const versionColumn = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'version'
  `;
  check(
    "products.version exists — optimistic stock concurrency",
    versionColumn.length === 1,
    versionColumn.length === 1 ? "version" : "MISSING",
  );

  // --- 7. data sanity (informational, never fails) -----------------------
  const counts = await prisma.$queryRaw<
    Array<{ products: bigint; orders: bigint }>
  >`
    SELECT
      (SELECT count(*) FROM products)::bigint AS products,
      (SELECT count(*) FROM orders)::bigint AS orders
  `;
  console.log(
    `\nInfo: ${Number(counts[0].products)} product(s), ${Number(counts[0].orders)} order(s) in this database.`,
  );

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) {
    console.log("\nFAILED — do not deploy against this database until the above are resolved.");
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error("\nCould not verify the database:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
