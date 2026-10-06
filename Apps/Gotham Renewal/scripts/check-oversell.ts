/**
 * Overselling check - the one test that must be run against a REAL database.
 *
 * Everything else in the suite is a unit test. This is not, and it cannot be:
 * the property under test is "two concurrent transactions cannot both reserve
 * the last unit", which only exists when Postgres is actually holding row
 * locks. A mock would pass this test while the bug stayed in production.
 *
 * Run it with:
 *   npm run check:oversell
 *
 * It is excluded from `npm test` (which must stay database-free) via the
 * `check:` prefix rather than `.test.ts`.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { withUtcSession } from "../src/lib/db/connection";

const adapter = new PrismaPg({ connectionString: withUtcSession(process.env.DATABASE_URL!) });
const prisma = new PrismaClient({ adapter });

/**
 * Reserve stock exactly as the order service does: a conditional decrement.
 * Returns whether the reservation succeeded. This mirrors
 * `decrementStock` in `lib/orders/repository.ts` - if that statement changes,
 * this check must change with it.
 */
async function tryReserve(productId: string, quantity: number): Promise<boolean> {
  const result = await prisma.product.updateMany({
    where: { id: productId, active: true, stock: { gte: quantity } },
    data: { stock: { decrement: quantity } },
  });
  return result.count === 1;
}

async function main() {
  const slug = `oversell-check-${Date.now()}`;

  const product = await prisma.product.create({
    data: {
      name: "Oversell Check Item",
      slug,
      description: "Temporary product used by the overselling check.",
      price: 10000,
      stock: 1, // exactly one unit, so only one reservation may win
      active: true,
    },
  });

  try {
    // Fire N concurrent reservations for the single unit.
    const attempts = 10;
    const results = await Promise.all(
      Array.from({ length: attempts }, () => tryReserve(product.id, 1)),
    );

    const succeeded = results.filter(Boolean).length;
    const product_after = await prisma.product.findUnique({ where: { id: product.id } });
    const finalStock = product_after?.stock;

    console.log(`Concurrent attempts for 1 unit: ${attempts}`);
    console.log(`Reservations that succeeded:   ${succeeded}`);
    console.log(`Final stock:                   ${finalStock}`);

    const problems: string[] = [];
    if (succeeded !== 1) {
      problems.push(`expected exactly 1 reservation to succeed, got ${succeeded}`);
    }
    if (finalStock !== 0) {
      problems.push(`expected final stock 0, got ${finalStock}`);
    }

    if (problems.length > 0) {
      console.error("\nFAIL: overselling protection is broken");
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exitCode = 1;
      return;
    }

    console.log("\nPASS: the last unit was reserved by exactly one request, stock never went negative.");
  } finally {
    await prisma.product.delete({ where: { id: product.id } }).catch(() => {});
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
