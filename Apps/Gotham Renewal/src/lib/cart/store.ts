/**
 * Pure cart logic.
 *
 * Every function here is pure: same input -> same output, and the input cart is
 * never mutated (new objects/arrays are returned). That is the whole point - it
 * makes the cart testable under plain Node with no browser and no React.
 *
 * React wiring lives in `context.tsx`; this file imports nothing from React.
 */

import { lineTotalPaise, sumPaise, type Paise } from "@/lib/money";
import type { Cart, CartLine } from "./types";

export function emptyCart(): Cart {
  return { lines: [] };
}

/**
 * Coerce a quantity to the cart's invariant: a non-negative integer.
 *
 * A CartLine's quantity must be a positive integer. `subtotalPaise` enforces
 * that via `lineTotalPaise`, which THROWS on anything else - and because the
 * subtotal is computed inside the provider's `useMemo`, one bad quantity would
 * crash every page that renders the cart. So the guard belongs here, at the
 * single point where quantities enter the state, not at each call site.
 *
 * Non-finite and negative values become 0, which callers read as "remove".
 * Fractional values are floored (an input of 1.5 means one unit, not a crash).
 */
function toValidQuantity(quantity: number): number {
  if (!Number.isFinite(quantity)) return 0;
  return Math.max(0, Math.floor(quantity));
}

/** Add a line, or increment the quantity if the product id is already present. */
export function addLine(cart: Cart, line: CartLine): Cart {
  const quantity = toValidQuantity(line.quantity);
  // Adding zero of something is a no-op, not a line with quantity 0.
  if (quantity === 0) return cart;

  const existing = getLine(cart, line.productId);
  if (existing) {
    return setQuantity(cart, line.productId, existing.quantity + quantity);
  }
  return { lines: [...cart.lines, { ...line, quantity }] };
}

/** Set a line's quantity; a quantity of zero or less removes the line. Unknown ids are a no-op. */
export function setQuantity(cart: Cart, productId: string, quantity: number): Cart {
  const valid = toValidQuantity(quantity);
  if (valid === 0) return removeLine(cart, productId);
  return {
    lines: cart.lines.map((line) =>
      line.productId === productId ? { ...line, quantity: valid } : line,
    ),
  };
}

export function removeLine(cart: Cart, productId: string): Cart {
  return { lines: cart.lines.filter((line) => line.productId !== productId) };
}

export function clearCart(): Cart {
  return emptyCart();
}

export function getLine(cart: Cart, productId: string): CartLine | undefined {
  return cart.lines.find((line) => line.productId === productId);
}

/** Total quantity across all lines (a line of 3 counts as 3, not 1). */
export function countLines(cart: Cart): number {
  return cart.lines.reduce((total, line) => total + line.quantity, 0);
}

/** Sum of every line total. Not authoritative - the server recomputes at checkout. */
export function subtotalPaise(cart: Cart): Paise {
  return sumPaise(
    cart.lines.map((line) => lineTotalPaise(line.unitPrice, line.quantity)),
  );
}
