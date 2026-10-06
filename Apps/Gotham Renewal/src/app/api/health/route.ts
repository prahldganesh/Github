/**
 * Health check.
 *
 * Purpose is narrower than it looks, and worth stating: Phase 1 has no product
 * catalog to read, so this endpoint is the one proof that the whole chain works
 * end to end:
 *
 *   browser -> Next.js server -> Prisma -> PostgreSQL -> back
 *
 * If `database: "up"` comes back, then Node, Next, Prisma, the generated client,
 * the driver adapter, the connection string and the running Postgres are all
 * correct. Phase 14 reuses the same endpoint for the uptime check.
 *
 * It deliberately exposes no business data and no secrets - just liveness.
 */
import { NextResponse } from "next/server";
import { checkDatabase } from "@/lib/health";

// Note (Next 16): Route Handlers are uncached by default and the Node.js runtime
// is the default, so neither `dynamic = "force-dynamic"` nor `runtime = "nodejs"`
// is needed. The Edge runtime is deprecated.

export async function GET() {
  const db = await checkDatabase();

  if (db.state === "down") {
    return NextResponse.json(
      { status: "error", database: "down" },
      { status: 503 },
    );
  }

  return NextResponse.json({
    status: "ok",
    database: "up",
    latencyMs: db.latencyMs,
  });
}
