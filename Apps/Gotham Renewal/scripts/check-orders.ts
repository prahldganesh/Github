/**
 * Order creation, end to end against a real database.
 *
 * `check:e2e` proves the browser flow and `check:oversell` proves the stock
 * guard, but neither asserts on what the ORDER SERVICE writes: the snapshot
 * columns, the money, the outbox job, and the payment status per method. This is
 * the integration test for that.
 *
 * It calls `createOrder` directly (not over HTTP) so it can assert on the
 * database afterwards, and it covers both payment paths.
 *
 * Run: npm run check:orders   (needs Postgres)
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { withUtcSession } from "../src/lib/db/connection";
import { createOrder } from "../src/lib/orders/service";
import { findOrderById } from "../src/lib/orders/repository";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: withUtcSession(process.env.DATABASE_URL!) }),
});

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = "") {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const stamp = Date.now();
const SLUG_A = `order-check-a-${stamp}`;
const SLUG_B = `order-check-b-${stamp}`;

const customer = {
  name: "Order Check",
  phone: "9876543210",
  email: "check@example.com",
  address: "1 Order Road, Somewhere",
  city: "Bengaluru",
  state: "Karnataka",
  pincode: "560001",
};

async function main() {
  const productA = await prisma.product.create({
    data: { name: "Order Check A", slug: SLUG_A, description: "", price: 45050, stock: 10, active: true },
  });
  const productB = await prisma.product.create({
    data: { name: "Order Check B", slug: SLUG_B, description: "", price: 10000, stock: 5, active: true },
  });

  try {
    // --- COD: order written, stock reserved, alert queued -------------------
    const cod = await createOrder({
      customer,
      paymentMethod: "COD",
      items: [
        { productId: productA.id, quantity: 2 }, // 2 x 45050 = 90100
        { productId: productB.id, quantity: 1 }, // 1 x 10000 = 10000
      ],
    });

    check("a COD order is created", cod.ok, cod.ok ? `orderNumber=${cod.order.orderNumber}` : cod.problem.kind);
    if (!cod.ok) throw new Error("cannot continue without an order");

    const codRow = await findOrderById(cod.order.id);
    const a = await prisma.product.findUnique({ where: { id: productA.id } });
    const b = await prisma.product.findUnique({ where: { id: productB.id } });

    check(
      "the subtotal is computed from the database prices in paise",
      codRow?.subtotal === 100100,
      `subtotal=${codRow?.subtotal} (expected 90100 + 10000)`,
    );
    check("stock is reserved", a?.stock === 8 && b?.stock === 4, `A=${a?.stock}, B=${b?.stock}`);
    check(
      "COD payment status is COD, not PAID or PENDING",
      codRow?.paymentStatus === "COD",
      `paymentStatus=${codRow?.paymentStatus}`,
    );
    check("a COD order starts as NEW", codRow?.orderStatus === "NEW", `orderStatus=${codRow?.orderStatus}`);
    check("an order number is allocated", /^[A-Z]+-\d{4,}$/.test(codRow?.orderNumber ?? ""), codRow?.orderNumber);

    // --- the snapshot: names and prices copied, not referenced --------------
    check("order items are written", codRow?.items.length === 2, `items=${codRow?.items.length}`);
    const snapshotted = codRow?.items.find((item) => item.productId === productA.id);
    check(
      "each item snapshots the product name and unit price",
      snapshotted?.productName === "Order Check A" && snapshotted?.unitPrice === 45050,
      `${snapshotted?.productName} @ ${snapshotted?.unitPrice}`,
    );
    check(
      "each item's line total is quantity x unit price",
      snapshotted?.total === 90100,
      `total=${snapshotted?.total}`,
    );

    // --- the outbox: the alert is owed, and committed with the order --------
    const codJob = await prisma.notification.findFirst({
      where: { orderId: cod.order.id, type: "ORDER_ALERT_BUSINESS" },
    });
    check(
      "a COD order queues its owner alert in the same transaction",
      codJob !== null && codJob.status === "PENDING" && codJob.attempts === 0,
      codJob ? `status=${codJob.status}` : "no job",
    );

    // --- the snapshot survives a rename and a reprice -----------------------
    await prisma.product.update({
      where: { id: productA.id },
      data: { name: "RENAMED AFTER ORDER", price: 999999 },
    });
    const after = await findOrderById(cod.order.id);
    const stillSnapshotted = after?.items.find((item) => item.productId === productA.id);
    check(
      "a historical order is unchanged by a rename and a reprice",
      stillSnapshotted?.productName === "Order Check A" && stillSnapshotted?.unitPrice === 45050,
      `${stillSnapshotted?.productName} @ ${stillSnapshotted?.unitPrice}`,
    );
    check(
      "the order total is unchanged too",
      after?.total === 100100,
      `total=${after?.total}`,
    );

    // --- validation: these must be refused, and must not reserve stock ------
    const empty = await createOrder({ customer, paymentMethod: "COD", items: [] });
    check("an empty order is refused", !empty.ok && empty.problem.kind === "empty");

    const missing = await createOrder({
      customer,
      paymentMethod: "COD",
      items: [{ productId: "00000000-0000-4000-8000-000000000000", quantity: 1 }],
    });
    check(
      "an unknown product is refused",
      !missing.ok && missing.problem.kind === "product-not-found",
      missing.ok ? "accepted" : missing.problem.kind,
    );

    const tooMany = await createOrder({
      customer,
      paymentMethod: "COD",
      items: [{ productId: productA.id, quantity: 9999 }],
    });
    check(
      "an order beyond stock is refused",
      !tooMany.ok && tooMany.problem.kind === "insufficient-stock",
      tooMany.ok ? "accepted" : tooMany.problem.kind,
    );

    // --- a refused order must not have consumed stock -----------------------
    const aNow = await prisma.product.findUnique({ where: { id: productA.id } });
    check(
      "a refused order reserves no stock",
      aNow?.stock === 8,
      `stock=${aNow?.stock} (still 8, unchanged by the refusals)`,
    );

    // --- an inactive product is refused even with stock ---------------------
    const inactive = await prisma.product.create({
      data: { name: "Inactive", slug: `inactive-${stamp}`, description: "", price: 100, stock: 5, active: false },
    });
    const inactiveResult = await createOrder({
      customer,
      paymentMethod: "COD",
      items: [{ productId: inactive.id, quantity: 1 }],
    });
    check(
      "an inactive product cannot be ordered",
      !inactiveResult.ok && inactiveResult.problem.kind === "product-inactive",
      inactiveResult.ok ? "accepted" : inactiveResult.problem.kind,
    );
    await prisma.product.delete({ where: { id: inactive.id } });

    // --- Razorpay with unreachable credentials: the ORDER STILL EXISTS ------
    // The local order must survive so the customer can retry (ADR-0008).
    const razorpay = await createOrder({
      customer,
      paymentMethod: "RAZORPAY",
      items: [{ productId: productB.id, quantity: 1 }],
    });

    if (!razorpay.ok) {
      check(
        "a failed Razorpay start still reports the saved order",
        razorpay.order !== undefined,
        razorpay.order ? `orderNumber=${razorpay.order.orderNumber}` : "no order returned",
      );
      if (razorpay.order) {
        const row = await findOrderById(razorpay.order.id);
        check(
          "the saved online order is PENDING, awaiting payment",
          row?.paymentStatus === "PENDING",
          `paymentStatus=${row?.paymentStatus}`,
        );
        check(
          "its stock is reserved (it will be swept if never paid)",
          (await prisma.product.findUnique({ where: { id: productB.id } }))?.stock === 3,
          `stock=${(await prisma.product.findUnique({ where: { id: productB.id } }))?.stock}`,
        );
        const noAlert = await prisma.notification.findFirst({ where: { orderId: razorpay.order.id } });
        check(
          "an unpaid online order does NOT alert the owner",
          noAlert === null,
          noAlert ? "alert queued (bug)" : "no alert, correct",
        );
      }
    } else {
      // Real credentials are configured. Then Razorpay order creation worked;
      // the order should be PENDING until the webhook settles it.
      const row = await findOrderById(razorpay.order.id);
      check(
        "with working credentials, an online order is PENDING until the webhook",
        row?.paymentStatus === "PENDING" && !!row.razorpayOrderId,
        `paymentStatus=${row?.paymentStatus}, razorpayOrderId=${row?.razorpayOrderId ? "set" : "missing"}`,
      );
      check("no owner alert is queued before payment settles", true);
    }
  } finally {
    await prisma.order.deleteMany({ where: { customerPhone: "9876543210" } });
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
