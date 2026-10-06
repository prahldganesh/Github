/**
 * Product service - business rules for reading the catalogue.
 *
 * The service is what pages and future API routes call. It may validate,
 * combine or cache, but it delegates all querying to the repository.
 *
 * Reads are wrapped in React's `cache()` so that a page which asks for the same
 * product twice (say, for the title and for the body) does not issue two
 * queries within a single request. This is per-request memoisation, NOT a
 * cross-request cache - stock and prices stay live.
 */
import "server-only";
import { cache } from "react";
import {
  findActiveProductBySlug,
  findActiveProducts,
  type ProductDetail,
  type ProductSummary,
} from "./repository";

/** The storefront catalogue: in-stock, active products. */
export const listCatalogue = cache(async (): Promise<ProductSummary[]> => {
  return findActiveProducts();
});

/**
 * A single product for its detail page, or null when it does not exist or is
 * not active. Returning null rather than throwing keeps the 404 decision in the
 * page, where it belongs.
 */
export const getProductBySlug = cache(
  async (slug: string): Promise<ProductDetail | null> => {
    const trimmed = slug.trim().toLowerCase();
    if (!trimmed) return null;
    return findActiveProductBySlug(trimmed);
  },
);

/**
 * Whether a product can be added to a cart: active and in stock.
 *
 * This is a convenience for the UI. The authoritative check happens at order
 * creation inside a transaction (Phase 6/7), because stock can change between
 * page render and checkout.
 */
export function isPurchasable(product: Pick<ProductDetail, "active" | "stock">): boolean {
  return product.active && product.stock > 0;
}
