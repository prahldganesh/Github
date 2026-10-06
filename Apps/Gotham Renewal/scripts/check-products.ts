/**
 * Product management check - against a REAL database.
 *
 * The unit suite (`npm test`) must stay database-free, so the parts of the
 * product service that touch Prisma are proven here instead. The claims:
 *
 *   1. createProduct inserts a product, converting rupees (from the form
 *      schema) to integer paise.
 *   2. A duplicate slug is refused as `{ ok: false, problem: slug-taken }` -
 *      NOT a thrown P2002.
 *   3. Disabling a product removes it from the storefront query
 *      (`findActiveProducts`) but `listProductsForAdmin` still returns it.
 *   4. setStock changes stock; a negative set is refused.
 *   5. A product referenced by an order item is NOT destroyed by disabling it,
 *      and the order item keeps its foreign key (history survives).
 *
 * Run (needs Postgres):
 *   npx tsx scripts/check-products.ts
 *
 * `server-only` is a no-op only under the React server condition, which the app
 * and the other `check:*` scripts supply via NODE_OPTIONS. This script re-execs
 * itself with that condition so the plain `npx tsx` command above works, without
 * having to edit package.json.
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { withUtcSession } from "../src/lib/db/connection";
import { decrementStock } from "../src/lib/orders/repository";

// The condition that turns `server-only` into a no-op. Without it, importing
// the management service throws ("cannot be imported from a Client Component").
if (!`${process.execArgv.join(" ")} ${process.env.NODE_OPTIONS ?? ""}`.includes("react-server")) {
  const child = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", new URL(import.meta.url).pathname],
    { stdio: "inherit", env: process.env },
  );
  process.exit(child.status ?? 1);
}

// The shared helper, NOT a raw connection string: the app forces the session to
// UTC, and skipping it makes every timestamp we write wrong (see db/connection).
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: withUtcSession(process.env.DATABASE_URL!) }),
});

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = "") {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  // Imported dynamically so the server-only modules load only after the
  // condition guard above has run.
  const management = await import("../src/lib/products/management");
  const repository = await import("../src/lib/products/repository");
  const { createProductSchema } = await import("../src/lib/validation/product");

  const stamp = Date.now();
  const slug = `check-products-${stamp}`;
  const createdIds: string[] = [];
  const orderIds: string[] = [];

  try {
    // --- 1. create, with rupees -> paise through the real schema ----------
    const parsed = createProductSchema.safeParse({
      name: "Check Products Item",
      slug,
      description: "created by check-products",
      priceRupees: "450.50",
      stock: "5",
      imageUrl: "",
      active: true,
    });
    check("the form schema converts 450.50 rupees to 45050 paise", parsed.success && parsed.data.price === 45050, parsed.success ? `price=${parsed.data.price}` : "schema parse failed");
    if (!parsed.success) throw new Error("schema unexpectedly failed");

    const created = await management.createProduct(parsed.data);
    check("createProduct inserts a product", created.ok, created.ok ? `id=${created.product.id}` : created.problem.kind);
    if (!created.ok) throw new Error("createProduct failed");
    createdIds.push(created.product.id);

    // --- 2. duplicate slug is a typed refusal, not a crash ----------------
    let duplicateCrashed = false;
    let duplicateResult: Awaited<ReturnType<typeof management.createProduct>> | null = null;
    try {
      duplicateResult = await management.createProduct({
        ...parsed.data,
        name: "Check Products Item Duplicate",
      });
    } catch {
      duplicateCrashed = true;
    }
    check(
      "a duplicate slug is refused as slug-taken, without throwing",
      !duplicateCrashed && duplicateResult?.ok === false && duplicateResult.problem.kind === "slug-taken",
      duplicateCrashed ? "it threw" : `ok=${duplicateResult?.ok}, kind=${duplicateResult && !duplicateResult.ok ? duplicateResult.problem.kind : "?"}`,
    );

    // --- 4a. setStock changes the value -----------------------------------
    const versionBeforeStock = (await management.getProductForAdmin(created.product.id))!.version;
    const setStock = await management.setStock(created.product.id, 42, versionBeforeStock);
    const afterSet = await management.getProductForAdmin(created.product.id);
    check(
      "setStock sets an absolute stock value",
      setStock.ok && afterSet?.stock === 42,
      `ok=${setStock.ok}, stock=${afterSet?.stock}`,
    );

    // --- 4b. negative stock is refused ------------------------------------
    const negative = await management.setStock(created.product.id, -1, versionBeforeStock);
    const afterNegative = await management.getProductForAdmin(created.product.id);
    check(
      "setting negative stock is refused and changes nothing",
      !negative.ok && negative.problem.kind === "invalid-stock" && afterNegative?.stock === 42,
      `ok=${negative.ok}, stock=${afterNegative?.stock}`,
    );

    // --- 3. disable hides it from the storefront, admin still sees it -----
    const versionBeforeDisable = (await management.getProductForAdmin(created.product.id))!.version;
    const disabled = await management.setProductActive(created.product.id, false, versionBeforeDisable);
    check("setProductActive(false) succeeds", disabled.ok, `ok=${disabled.ok}`);

    const storefront = await repository.findActiveProducts();
    const inStorefront = storefront.some((p) => p.id === created.product.id);
    const inAdmin = (await management.listProductsForAdmin()).some((p) => p.id === created.product.id);
    check(
      "a disabled product disappears from the storefront query",
      !inStorefront,
      `foundInStorefront=${inStorefront}`,
    );
    check(
      "a disabled product is still returned by listProductsForAdmin",
      inAdmin,
      `foundInAdmin=${inAdmin}`,
    );

    // --- 5. an order item keeps its product reference through a disable ---
    // Enable it first and give it stock so the order is realistic.
    await management.setProductActive(created.product.id, true, (await management.getProductForAdmin(created.product.id))!.version);
    await management.setStock(created.product.id, 3, (await management.getProductForAdmin(created.product.id))!.version);

    const order = await prisma.order.create({
      data: {
        orderNumber: `CKP-${stamp}`,
        customerName: "Check Products",
        customerPhone: "9876543210",
        address: "1 Check Road, Somewhere",
        city: "Bengaluru",
        state: "Karnataka",
        pincode: "560001",
        subtotal: 45050,
        shipping: 0,
        total: 45050,
        paymentMethod: "COD",
        paymentStatus: "COD",
        orderStatus: "NEW",
        items: {
          create: [
            {
              productId: created.product.id,
              productName: created.product.name,
              quantity: 1,
              unitPrice: 45050,
              total: 45050,
            },
          ],
        },
      },
    });
    orderIds.push(order.id);

    await management.setProductActive(created.product.id, false, (await management.getProductForAdmin(created.product.id))!.version);

    const stillThere = await management.getProductForAdmin(created.product.id);
    const item = await prisma.orderItem.findFirst({ where: { orderId: order.id } });
    check(
      "disabling a product does not delete it",
      stillThere !== null,
      stillThere ? `active=${stillThere.active}` : "row is gone",
    );
    check(
      "the order item keeps its product foreign key after a disable",
      item?.productId === created.product.id,
      `productId=${item?.productId}`,
    );

    // --- updateProduct also refused a duplicate slug -----------------------
    const second = await management.createProduct({
      ...parsed.data,
      slug: `${slug}-b`,
      name: "Check Products Item B",
    });
    if (second.ok) createdIds.push(second.product.id);
    const clash = second.ok
      ? await management.updateProduct(second.product.id, { ...parsed.data, slug }, (await management.getProductForAdmin(second.product.id))!.version)
      : null;
    check(
      "updateProduct refuses a slug already taken by another product",
      clash !== null && !clash.ok && clash.problem.kind === "slug-taken",
      clash ? `ok=${clash.ok}` : "second create failed",
    );

  // --- 12. optimistic concurrency ------------------------------------------
  // The last-write-wins bug this closes: two admins both read stock 10; A sets 8;
  // B, still holding the old version, sets 15. Without the version guard B would
  // silently erase A's change.
  const conc = await management.createProduct(
    {
      name: "Concurrency Product",
      slug: `concurrency-${stamp}`,
      description: "",
      price: 10000,
      stock: 10,
      imageUrl: null,
      active: true,
    } as never,
  );
  if (!conc.ok) throw new Error("could not create the concurrency fixture");

  const versionA = (await management.getProductForAdmin(conc.product.id))!.version;
  const versionB = (await management.getProductForAdmin(conc.product.id))!.version;

  const editA = await management.setStock(conc.product.id, 8, versionA);
  const editB = await management.setStock(conc.product.id, 15, versionB);
  const afterEdits = await prisma.product.findUnique({ where: { id: conc.product.id } });

  check("the first admin edit succeeds", editA.ok, editA.ok ? "ok" : "refused");
  check(
    "the second admin's stale edit is refused",
    !editB.ok && editB.problem.kind === "stale-edit",
    editB.ok ? "accepted (BUG)" : editB.problem.kind,
  );
  check(
    "the stale edit did not overwrite the newer value",
    afterEdits?.stock === 8,
    `stock=${afterEdits?.stock}`,
  );
  check(
    "the version advanced for each successful write",
    afterEdits?.version === versionA + 1,
    `version=${afterEdits?.version}`,
  );

  // --- 13. an admin edit racing a customer purchase ------------------------
  // The admin reads stock, a sale lands, then the admin saves. The sale must not
  // be erased, and stock must never go negative.
  const versionBeforeSale = (await management.getProductForAdmin(conc.product.id))!.version;
  await prisma.$transaction((tx) => decrementStock(tx, conc.product.id, 1));
  const staleAfterSale = await management.setStock(conc.product.id, 100, versionBeforeSale);
  const afterSale = await prisma.product.findUnique({ where: { id: conc.product.id } });

  check(
    "an admin save based on a pre-sale read is refused",
    !staleAfterSale.ok && staleAfterSale.problem.kind === "stale-edit",
    staleAfterSale.ok ? "accepted (BUG)" : staleAfterSale.problem.kind,
  );
  check(
    "the sale is not erased by the stale admin edit",
    afterSale?.stock === 7,
    `stock=${afterSale?.stock} (10 - 1 sale = 7)`,
  );
  check("stock never went negative", (afterSale?.stock ?? -1) >= 0, `stock=${afterSale?.stock}`);

  await prisma.product.delete({ where: { id: conc.product.id } });

  } finally {
    // Clean up everything this script created, in dependency order. Order items
    // cascade with their order; products are removed only here, never by the
    // service.
    if (orderIds.length > 0) {
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    if (createdIds.length > 0) {
      await prisma.product.deleteMany({ where: { id: { in: createdIds } } });
    }
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
