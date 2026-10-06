/**
 * Product repository - the only code that queries the product table.
 *
 * Kept separate from the service so that the business rules (what counts as
 * "visible", how a slug is validated) survive a change of data store, and so
 * that every product query lives in one reviewable place.
 */
import "server-only";
import { prisma } from "@/lib/db";
import type { Product } from "@/generated/prisma/client";

/** Fields the storefront needs for a catalogue card. Deliberately narrow. */
export type ProductSummary = Pick<
  Product,
  "id" | "name" | "slug" | "price" | "imageUrl" | "stock" | "active"
>;

export type ProductDetail = Product;

/**
 * Products visible in the catalogue: active, and with at least one unit in
 * stock. Inactive products are hidden rather than deleted so historical orders
 * stay valid.
 */
export async function findActiveProducts(): Promise<ProductSummary[]> {
  return prisma.product.findMany({
    where: { active: true, stock: { gt: 0 } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      slug: true,
      price: true,
      imageUrl: true,
      stock: true,
      active: true,
    },
  });
}

/**
 * A product by slug for the detail page. Inactive products are not returned to
 * the storefront: a disabled product must 404, not render a page that cannot be
 * ordered.
 */
export async function findActiveProductBySlug(slug: string): Promise<ProductDetail | null> {
  return prisma.product.findFirst({
    where: { slug, active: true },
  });
}

/** Every product, including inactive ones. For the admin screens (Phase 13). */
export async function findAllProducts(): Promise<ProductDetail[]> {
  return prisma.product.findMany({ orderBy: { createdAt: "desc" } });
}

export async function findProductById(id: string): Promise<ProductDetail | null> {
  return prisma.product.findUnique({ where: { id } });
}

export async function countProducts(): Promise<number> {
  return prisma.product.count();
}
