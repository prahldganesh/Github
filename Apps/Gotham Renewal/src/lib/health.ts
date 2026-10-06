/**
 * Server-side health check.
 *
 * Phase 1 has no domain tables yet, so connectivity is proven with `SELECT 1`
 * rather than a model query. That is deliberate: it tests Node -> Prisma ->
 * adapter -> Postgres without pre-empting a schema that Phase 2 owns.
 *
 * Imports `lib/db`, which is `server-only`, so this can never be pulled into a
 * Client Component - the runtime split in docs/ARCHITECTURE.md, demonstrated.
 */
import { prisma } from "@/lib/db";
import { logger, errorFields } from "@/lib/logger";

export type DbStatus =
  | { state: "up"; latencyMs: number }
  | { state: "down"; reason: string };

export async function checkDatabase(): Promise<DbStatus> {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { state: "up", latencyMs: Date.now() - startedAt };
  } catch (error) {
    logger.warn("database check failed", errorFields(error));
    return {
      state: "down",
      reason: error instanceof Error ? error.message : "unknown error",
    };
  }
}
