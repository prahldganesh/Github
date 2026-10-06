/**
 * Cart types.
 *
 * The cart lives entirely in the browser (Phase 4). There is no server cart and
 * no database: it is serialised into a checkout request later as `cart id +
 * quantity` pairs only.
 *
 * The server is authoritative about prices. The name and price carried on a
 * line exist ONLY so the storefront can render a cart without a round trip;
 * checkout re-reads both from the database.
 */

import type { Paise } from "@/lib/money";

export type CartLine = {
  /** The Product's internal id, and the only thing sent to the server at checkout. */
  productId: string;
  /** The Product's Slug, for linking back to `/products/[slug]`. */
  slug: string;
  /** Display convenience only - NOT authoritative. The server re-reads the name at checkout. */
  name: string;
  /** Display convenience only - NOT authoritative. The server re-reads the price at checkout. */
  unitPrice: Paise;
  /** Positive integer. */
  quantity: number;
};

export type Cart = {
  lines: readonly CartLine[];
};
