/**
 * Order pricing - the authoritative money calculation.
 *
 * This module is PURE: it takes the products the server loaded from the
 * database and the quantities the browser asked for, and returns the money.
 * It performs no I/O, which is what makes the whole "is the total correct?"
 * question testable without a database.
 *
 * The rule it exists to enforce: **the browser never supplies money.** A
 * request carries product ids and quantities only. Every rupee here comes from
 * a `Product` row that this process read from Postgres.
 *
 * All arithmetic is integer paise (see `@/lib/money`). No floats, ever.
 */
import { lineTotalPaise, sumPaise, type Paise } from "@/lib/money";

/** A product as loaded from the database, narrowed to what pricing needs. */
export type PricedProduct = {
  id: string;
  name: string;
  slug: string;
  /** Unit price in paise, straight from the database. */
  price: Paise;
  stock: number;
  active: boolean;
};

/** One line the customer asked for. Quantities only - never a price. */
export type RequestedLine = {
  productId: string;
  quantity: number;
};

export type PricedLine = {
  product: PricedProduct;
  quantity: number;
  unitPrice: Paise;
  total: Paise;
};

export type PricingConfig = {
  /** Flat shipping charge in paise. */
  shippingFeePaise: Paise;
  /** Orders with a subtotal at or above this ship free. 0 disables the rule. */
  freeShippingThresholdPaise: Paise;
};

export type PricingProblem =
  | { kind: "empty" }
  | { kind: "product-not-found"; productId: string }
  | { kind: "product-inactive"; productId: string; name: string }
  | { kind: "insufficient-stock"; productId: string; name: string; requested: number; available: number }
  | { kind: "invalid-quantity"; productId: string; quantity: number };

export type PricingResult =
  | {
      ok: true;
      lines: PricedLine[];
      subtotalPaise: Paise;
      shippingPaise: Paise;
      totalPaise: Paise;
    }
  | { ok: false; problem: PricingProblem };

/**
 * Compute an order's money from database products and requested quantities.
 *
 * Returns a typed problem rather than throwing, because "this product is out of
 * stock" is an answer the API needs to turn into a 409, not an exception.
 *
 * Stock is checked here for a good error message, but this is NOT the
 * concurrency guard: the authoritative check is the conditional decrement in
 * the order transaction, which is atomic. Two requests can both pass this
 * function and only one will win the decrement.
 */
export function priceOrder(
  products: readonly PricedProduct[],
  requested: readonly RequestedLine[],
  config: PricingConfig,
): PricingResult {
  if (requested.length === 0) {
    return { ok: false, problem: { kind: "empty" } };
  }

  const byId = new Map(products.map((product) => [product.id, product]));
  const lines: PricedLine[] = [];

  for (const line of requested) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      return {
        ok: false,
        problem: { kind: "invalid-quantity", productId: line.productId, quantity: line.quantity },
      };
    }

    const product = byId.get(line.productId);
    if (!product) {
      return { ok: false, problem: { kind: "product-not-found", productId: line.productId } };
    }
    if (!product.active) {
      return {
        ok: false,
        problem: { kind: "product-inactive", productId: product.id, name: product.name },
      };
    }
    if (product.stock < line.quantity) {
      return {
        ok: false,
        problem: {
          kind: "insufficient-stock",
          productId: product.id,
          name: product.name,
          requested: line.quantity,
          available: product.stock,
        },
      };
    }

    lines.push({
      product,
      quantity: line.quantity,
      unitPrice: product.price,
      total: lineTotalPaise(product.price, line.quantity),
    });
  }

  const subtotalPaise = sumPaise(lines.map((line) => line.total));
  const shippingPaise = computeShipping(subtotalPaise, config);
  const totalPaise = subtotalPaise + shippingPaise;

  return { ok: true, lines, subtotalPaise, shippingPaise, totalPaise };
}

/**
 * Shipping for a given subtotal.
 *
 * Free-shipping threshold of 0 means "no threshold" (never free), which is the
 * sensible reading of a disabled rule. A zero fee means shipping is always free
 * regardless of subtotal.
 */
export function computeShipping(subtotalPaise: Paise, config: PricingConfig): Paise {
  if (config.shippingFeePaise <= 0) return 0;
  if (config.freeShippingThresholdPaise > 0 && subtotalPaise >= config.freeShippingThresholdPaise) {
    return 0;
  }
  return config.shippingFeePaise;
}
