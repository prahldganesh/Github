/**
 * Product management service (Phase 13 - admin product management).
 *
 * The business rules for an administrator creating, editing, disabling and
 * re-stocking a product. Reads reuse the existing repository queries - this file
 * is only the WRITE side, because the storefront (and the original repository)
 * is deliberately read-only.
 *
 * WHY A DISCRIMINATED RESULT AND NEVER A THROW. An expected failure - "that
 * slug is already taken", "that product is gone" - is a normal outcome of a
 * form submission, not a fault. Returning `{ ok: false, problem }` lets the
 * server action turn it into a friendly query-string error, while a genuine
 * fault (the database is down) still throws and is logged. This mirrors the
 * `UpdateStatusResult` shape in src/lib/orders/admin-service.ts.
 *
 * WHY DISABLE, NEVER DELETE. See CONTEXT.md "Active": an order item holds a
 * *snapshot* of the product's name and price, and a foreign key to the product
 * row. Deleting the product would leave history dangling (or, with the schema's
 * SetNull, silently orphan it). Disabling hides it from the storefront and keeps
 * history intact, so there is deliberately no `deleteProduct` here.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { logger, errorFields } from "@/lib/logger";
import { findAllProducts, findProductById, type ProductDetail } from "./repository";
import {
  normalisePricePaise,
  normaliseSlug,
  SLUG_PATTERN,
  type CreateProductInput,
} from "@/lib/validation/product";

export type ProductProblem =
  | { kind: "slug-taken" }
  | { kind: "invalid-slug" }
  | { kind: "invalid-price" }
  | { kind: "invalid-stock" }
  | { kind: "not-found" }
  /**
   * The product changed since the admin loaded it.
   *
   * Not an error - a normal, expected outcome of two people editing at once, or
   * of a sale landing between the admin opening the page and saving. The UI is
   * expected to say so and show the new state rather than retrying blindly.
   */
  | { kind: "stale-edit" };

export type ProductMutationResult =
  | { ok: true; product: ProductDetail }
  | { ok: false; problem: ProductProblem };

/** Postgres unique-violation, as Prisma reports it. */
const UNIQUE_VIOLATION = "P2002";

function isPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === code
  );
}

/** A client-safe message for a problem. No internal detail. */
export function messageForProblem(problem: ProductProblem): string {
  switch (problem.kind) {
    case "slug-taken":
      return "That slug is already in use. Choose another.";
    case "invalid-slug":
      return "That slug is not valid. Use lowercase letters, numbers and hyphens.";
    case "invalid-price":
      return "The price is not valid.";
    case "invalid-stock":
      return "Stock must be a whole number of zero or more.";
    case "not-found":
      return "That product could not be found.";
    case "stale-edit":
      return "This product was changed by someone else, or by a sale, while you were editing it. Reload the page to see the current values before saving.";
  }
}

/**
 * A product by id for the admin, INCLUDING inactive ones.
 *
 * The storefront's `findActiveProductBySlug` filters `active: true`; an admin
 * must be able to open a disabled product to re-enable it or read its details.
 */
export async function getProductForAdmin(id: string): Promise<ProductDetail | null> {
  return findProductById(id);
}

/** Every product, active or not, newest first. For the admin table. */
export async function listProductsForAdmin(): Promise<ProductDetail[]> {
  return findAllProducts();
}

/** Prepare the columns a create/update writes, or report why they are invalid. */
function normaliseWritableFields(
  input: CreateProductInput,
): {
  ok: true;
  data: Omit<ProductDetail, "id" | "createdAt" | "updatedAt" | "version">;
} | { ok: false; problem: ProductProblem } {
  const slug = normaliseSlug(input.slug);
  if (slug.length < 2 || slug.length > 200 || !SLUG_PATTERN.test(slug)) {
    return { ok: false, problem: { kind: "invalid-slug" } };
  }

  const price = normalisePricePaise(input.price);
  if (price === null) return { ok: false, problem: { kind: "invalid-price" } };

  if (!Number.isInteger(input.stock) || input.stock < 0) {
    return { ok: false, problem: { kind: "invalid-stock" } };
  }

  return {
    ok: true,
    data: {
      name: input.name,
      slug,
      description: input.description,
      price,
      stock: input.stock,
      imageUrl: input.imageUrl,
      active: input.active,
    },
  };
}

/**
 * Create a product.
 *
 * The price arrives already in paise - the Zod schema converted it from the
 * rupees the admin typed (see src/lib/validation/product.ts). A duplicate slug
 * is a unique violation on the `slug` column; it is caught and reported as
 * `slug-taken` so the form can say so, rather than crashing the request.
 */
export async function createProduct(input: CreateProductInput): Promise<ProductMutationResult> {
  const fields = normaliseWritableFields(input);
  if (!fields.ok) return fields;

  try {
    const product = await prisma.product.create({ data: fields.data });
    logger.info("product created", {
      productId: product.id,
      slug: product.slug,
      price: product.price,
    });
    return { ok: true, product };
  } catch (error) {
    if (isPrismaCode(error, UNIQUE_VIOLATION)) {
      logger.warn("product slug conflict", { slug: input.slug });
      return { ok: false, problem: { kind: "slug-taken" } };
    }
    logger.error("failed to create product", errorFields(error));
    throw error;
  }
}

/**
 * Update a product's writable fields, refusing a stale edit.
 *
 * `expectedVersion` is the version the admin's form was rendered from. The
 * update is conditional on it, so:
 *
 *   - if nobody else touched the product, the version matches and it saves;
 *   - if a sale reserved stock, or another admin saved, or the sweep returned
 *     stock, the version has moved and this matches ZERO ROWS.
 *
 * Zero rows means "your edit was based on stale data" - reported as `stale-edit`,
 * never retried automatically. Silently overwriting the newer value is exactly
 * the bug this prevents (ADR-0009's acknowledged gap, now closed).
 *
 * The version is incremented in the same statement, so two admins saving at the
 * same instant cannot both win: Postgres serialises the updates on the row, the
 * second sees the incremented version and fails its guard.
 */
export async function updateProduct(
  id: string,
  input: CreateProductInput,
  expectedVersion: number,
): Promise<ProductMutationResult> {
  const fields = normaliseWritableFields(input);
  if (!fields.ok) return fields;

  try {
    const result = await prisma.product.updateMany({
      where: { id, version: expectedVersion },
      data: { ...fields.data, version: { increment: 1 } },
    });

    if (result.count === 0) {
      // Either the product is gone, or the version moved. Distinguish so the
      // message is accurate.
      const exists = await prisma.product.findUnique({ where: { id }, select: { id: true } });
      logger.warn("product update refused", {
        productId: id,
        expectedVersion,
        reason: exists ? "stale-edit" : "not-found",
      });
      return { ok: false, problem: { kind: exists ? "stale-edit" : "not-found" } };
    }

    const product = await prisma.product.findUniqueOrThrow({ where: { id } });
    logger.info("product updated", {
      productId: product.id,
      slug: product.slug,
      price: product.price,
      active: product.active,
      version: product.version,
    });
    return { ok: true, product };
  } catch (error) {
    if (isPrismaCode(error, UNIQUE_VIOLATION)) {
      logger.warn("product slug conflict on update", { productId: id, slug: input.slug });
      return { ok: false, problem: { kind: "slug-taken" } };
    }
    logger.error("failed to update product", errorFields(error));
    throw error;
  }
}

/**
 * Enable or disable a product, refusing a stale edit.
 *
 * Guarded on the version for the same reason as stock: two admins toggling at
 * once should not both believe they won.
 */
export async function setProductActive(
  id: string,
  active: boolean,
  expectedVersion: number,
): Promise<ProductMutationResult> {
  try {
    const result = await prisma.product.updateMany({
      where: { id, version: expectedVersion },
      data: { active, version: { increment: 1 } },
    });

    if (result.count === 0) {
      const exists = await prisma.product.findUnique({ where: { id }, select: { id: true } });
      return { ok: false, problem: { kind: exists ? "stale-edit" : "not-found" } };
    }

    const product = await prisma.product.findUniqueOrThrow({ where: { id } });
    logger.info("product active flag changed", { productId: id, active, version: product.version });
    return { ok: true, product };
  } catch (error) {
    logger.error("failed to change product active flag", errorFields(error));
    throw error;
  }
}

/**
 * Set a product's stock to an absolute value, refusing a stale edit.
 *
 * Absolute, not an increment. An admin editing "stock" is asserting the real
 * count on the shelf; adding a delta to a stale number would compound whatever
 * drift already existed (ADR-0009).
 *
 * `expectedVersion` closes the remaining gap in that decision: without it, an
 * admin who loaded 10 and saved 8 would silently erase a sale that happened in
 * between. With it, the stale save is refused and the admin sees the new value.
 *
 * This is the ADMIN path. The customer purchase path uses `decrementStock`,
 * which is a guarded decrement - a different operation, deliberately, because
 * one asserts a count and the other moves it.
 */
export async function setStock(
  id: string,
  stock: number,
  expectedVersion: number,
): Promise<ProductMutationResult> {
  if (!Number.isInteger(stock) || stock < 0) {
    return { ok: false, problem: { kind: "invalid-stock" } };
  }

  try {
    const result = await prisma.product.updateMany({
      where: { id, version: expectedVersion },
      data: { stock, version: { increment: 1 } },
    });

    if (result.count === 0) {
      const exists = await prisma.product.findUnique({ where: { id }, select: { id: true } });
      logger.warn("stock set refused", {
        productId: id,
        expectedVersion,
        reason: exists ? "stale-edit" : "not-found",
      });
      return { ok: false, problem: { kind: exists ? "stale-edit" : "not-found" } };
    }

    const product = await prisma.product.findUniqueOrThrow({ where: { id } });
    logger.info("product stock set", { productId: id, stock, version: product.version });
    return { ok: true, product };
  } catch (error) {
    logger.error("failed to set product stock", errorFields(error));
    throw error;
  }
}
