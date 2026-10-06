/**
 * Abandoned-order sweep check, against a real database.
 *
 * The dangerous property under test: the sweep must NEVER cancel or restock an
 * order that has been paid, even when the payment lands at the same moment. A
 * unit test cannot prove that - it needs Postgres row locks.
 *
 *   A. A stale unpaid order is cancelled and its stock returned.
 *   B. A RECENT unpaid order is left alone (not yet abandoned by the customer).
 *   C. A stale order that is PAID is untouched - and its stock is NOT returned.
 *   D. A COD order is never swept, however old and whatever its status.
 *   E. The guard: if the order becomes PAID between the sweep finding it and
 *      cancelling it, the cancel matches zero rows and stock is unchanged.
 *   F. A product disabled after the order was placed is still restocked.
 *
 * Run: npm run check:sweep   (needs Postgres)
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { withUtcSession } from "../src/lib/db/connection";
import { sweepStalePendingOrders } from "../src/lib/orders/sweep";
import { abandonUnpaidOrder } from "../src/lib/orders/repository";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: withUtcSession(process.env.DATABASE_URL!) }),
});

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = "") {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const stamp = Date.now();

/** Create a product with a known stock. */
async function makeProduct(suffix: string, stock: number) {
  return prisma.product.create({
    data: {
      name: `Sweep ${suffix}`,
      slug: `sweep-${suffix}-${stamp}`,
      description: "",
      price: 10000,
      stock,
      active: true,
    },
  });
}

/**
 * Create an order. `ageMinutes` backdates created_at, which is what the sweep
 * filters on. Written via raw SQL because Prisma will not let `created_at` be
 * set explicitly when it has a @default(now()) - and it must go through the
 * UTC session so the comparison is honest.
 */
async function makeOrder(options: {
  number: string;
  productId: string | null;
  quantity: number;
  method: "RAZORPAY" | "COD";
  paymentStatus: "PENDING" | "PAID" | "COD";
  orderStatus: "NEW" | "CONFIRMED" | "CANCELLED";
  ageMinutes: number;
}): Promise<string> {
  const order = await prisma.order.create({
    data: {
      orderNumber: `${options.number}-${stamp}`,
      customerName: "Sweep Test",
      customerPhone: "9876543210",
      address: "1 Sweep Road, Somewhere",
      city: "Bengaluru",
      state: "Karnataka",
      pincode: "560001",
      subtotal: 10000 * options.quantity,
      shipping: 0,
      total: 10000 * options.quantity,
      paymentMethod: options.method,
      paymentStatus: options.paymentStatus,
      orderStatus: options.orderStatus,
      items: {
        create: [
          {
            productId: options.productId,
            productName: "Sweep Item",
            quantity: options.quantity,
            unitPrice: 10000,
            total: 10000 * options.quantity,
          },
        ],
      },
    },
  });

  // Backdate it so the sweep considers it stale.
  await prisma.$executeRaw`
    UPDATE orders SET created_at = now() - (${options.ageMinutes}::int * interval '1 minute')
    WHERE id = ${order.id}::uuid
  `;
  return order.id;
}

async function stockOf(productId: string): Promise<number | undefined> {
  return (await prisma.product.findUnique({ where: { id: productId } }))?.stock;
}

async function main() {
  const product = await makeProduct("main", 10);
  const recentProduct = await makeProduct("recent", 10);
  const paidProduct = await makeProduct("paid", 10);
  const codProduct = await makeProduct("cod", 10);
  const raceProduct = await makeProduct("race", 10);

  try {
    // --- A. stale unpaid -> cancelled and restocked -------------------------
    const staleId = await makeOrder({
      number: "SW-A", productId: product.id, quantity: 2,
      method: "RAZORPAY", paymentStatus: "PENDING", orderStatus: "NEW", ageMinutes: 120,
    });
    await prisma.product.update({ where: { id: product.id }, data: { stock: { decrement: 2 } } });
    const beforeA = await stockOf(product.id);

    // --- B. recent unpaid -> untouched --------------------------------------
    const recentId = await makeOrder({
      number: "SW-B", productId: recentProduct.id, quantity: 1,
      method: "RAZORPAY", paymentStatus: "PENDING", orderStatus: "NEW", ageMinutes: 5,
    });
    await prisma.product.update({ where: { id: recentProduct.id }, data: { stock: { decrement: 1 } } });

    // --- C. stale but PAID -> untouched, stock NOT returned -----------------
    const paidId = await makeOrder({
      number: "SW-C", productId: paidProduct.id, quantity: 1,
      method: "RAZORPAY", paymentStatus: "PAID", orderStatus: "NEW", ageMinutes: 300,
    });
    await prisma.product.update({ where: { id: paidProduct.id }, data: { stock: { decrement: 1 } } });
    const beforeC = await stockOf(paidProduct.id);

    // --- D. stale COD -> never swept ----------------------------------------
    const codId = await makeOrder({
      number: "SW-D", productId: codProduct.id, quantity: 1,
      method: "COD", paymentStatus: "COD", orderStatus: "NEW", ageMinutes: 1000,
    });
    await prisma.product.update({ where: { id: codProduct.id }, data: { stock: { decrement: 1 } } });
    const beforeD = await stockOf(codProduct.id);

    // --- run the sweep ------------------------------------------------------
    const result = await sweepStalePendingOrders(60, 50);
    console.log(`   sweep: examined=${result.examined} cancelled=${result.cancelled} skipped=${result.skipped} failed=${result.failed}`);

    const afterProduct = await stockOf(product.id);
    const a = await prisma.order.findUnique({ where: { id: staleId } });
    check(
      "A stale unpaid order is cancelled and its stock returned",
      a?.orderStatus === "CANCELLED" && beforeA === 8 && afterProduct === 10,
      `status=${a?.orderStatus}, stock ${beforeA} -> ${afterProduct}`,
    );
    check(
      "the abandoned order's payment status becomes FAILED",
      a?.paymentStatus === "FAILED",
      `paymentStatus=${a?.paymentStatus}`,
    );

    const b = await prisma.order.findUnique({ where: { id: recentId } });
    check(
      "a recent unpaid order is left alone",
      b?.orderStatus === "NEW" && b?.paymentStatus === "PENDING",
      `status=${b?.orderStatus}/${b?.paymentStatus}`,
    );

    const c = await prisma.order.findUnique({ where: { id: paidId } });
    const afterC = await stockOf(paidProduct.id);
    check(
      "a stale PAID order is NOT cancelled",
      c?.orderStatus === "NEW" && c?.paymentStatus === "PAID",
      `status=${c?.orderStatus}/${c?.paymentStatus}`,
    );
    check(
      "a stale PAID order's stock is NOT returned",
      afterC === beforeC,
      `stock ${beforeC} -> ${afterC}`,
    );

    const d = await prisma.order.findUnique({ where: { id: codId } });
    const afterD = await stockOf(codProduct.id);
    check(
      "a stale COD order is never swept, even a day old",
      d?.orderStatus === "NEW" && afterD === beforeD,
      `status=${d?.orderStatus}, stock ${beforeD} -> ${afterD}`,
    );

    // --- E. the guard, directly --------------------------------------------
    // Created AFTER the sweep above, so it is still PENDING when we mark it
    // PAID - which is the situation being simulated: a payment that arrives
    // after the sweep has already selected the order as a candidate.
    const raceId = await makeOrder({
      number: "SW-E", productId: raceProduct.id, quantity: 1,
      method: "RAZORPAY", paymentStatus: "PENDING", orderStatus: "NEW", ageMinutes: 120,
    });
    await prisma.product.update({ where: { id: raceProduct.id }, data: { stock: { decrement: 1 } } });

    // Now mark it PAID, then attempt the abandonment the sweep would have done.
    await prisma.order.update({ where: { id: raceId }, data: { paymentStatus: "PAID" } });
    const beforeRace = await stockOf(raceProduct.id);
    const guardedCount = await prisma.$transaction((tx) => abandonUnpaidOrder(tx, raceId));
    const afterRace = await stockOf(raceProduct.id);
    const raceAfter = await prisma.order.findUnique({ where: { id: raceId } });
    check(
      "a paid order cannot be abandoned (guarded update matches zero rows)",
      guardedCount === 0,
      `rows matched=${guardedCount}`,
    );
    check(
      "the guarded update left the paid order and its stock intact",
      raceAfter?.orderStatus === "NEW" && afterRace === beforeRace,
      `status=${raceAfter?.orderStatus}, stock ${beforeRace} -> ${afterRace}`,
    );

    // --- F. a disabled product is still restocked --------------------------
    const disabledProduct = await makeProduct("disabled", 0);
    const disabledOrderId = await makeOrder({
      number: "SW-F", productId: disabledProduct.id, quantity: 1,
      method: "RAZORPAY", paymentStatus: "PENDING", orderStatus: "NEW", ageMinutes: 120,
    });
    await prisma.product.update({ where: { id: disabledProduct.id }, data: { active: false } });

    await sweepStalePendingOrders(60, 50);
    const afterDisabled = await stockOf(disabledProduct.id);
    check(
      "cancelling an order restocks even a product that was disabled afterwards",
      afterDisabled === 1,
      `stock=${afterDisabled}`,
    );
    await prisma.order.delete({ where: { id: disabledOrderId } });
    await prisma.product.delete({ where: { id: disabledProduct.id } });
  } finally {
    await prisma.order.deleteMany({ where: { orderNumber: { endsWith: `-${stamp}` } } });
    await prisma.product.deleteMany({ where: { slug: { endsWith: `-${stamp}` } } });
    await prisma.$disconnect();
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
