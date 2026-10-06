"use client";

/**
 * Cart React context.
 *
 * Holds the pure `Cart` state from `store.ts` in a `useReducer` and persists it
 * to localStorage. All persistence concerns live here; components only ever
 * call the actions below and never touch localStorage.
 *
 * SSR note: the app uses Server Components, so there is no `window` during the
 * first render. State is read in an effect after mount - reading during render
 * would produce a hydration mismatch between the server's empty cart and the
 * browser's persisted one.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import type { Paise } from "@/lib/money";
import {
  addLine as addLineTo,
  clearCart as clear,
  countLines as countOf,
  emptyCart,
  getLine as getLineFrom,
  removeLine as removeLineFrom,
  setQuantity as setQuantityOn,
  subtotalPaise as subtotalOf,
} from "./store";
import type { Cart, CartLine } from "./types";

const STORAGE_KEY = "gotham.cart.v1";

type Action =
  | { type: "add"; line: CartLine }
  | { type: "setQuantity"; productId: string; quantity: number }
  | { type: "remove"; productId: string }
  | { type: "clear" }
  | { type: "hydrate"; cart: Cart };

type State = { cart: Cart; hydrated: boolean };

function reducer(state: State, action: Action): State {
  const cart = cartReducer(state.cart, action);
  return { cart, hydrated: state.hydrated || action.type === "hydrate" };
}

function cartReducer(cart: Cart, action: Action): Cart {
  switch (action.type) {
    case "add":
      return addLineTo(cart, action.line);
    case "setQuantity":
      return setQuantityOn(cart, action.productId, action.quantity);
    case "remove":
      return removeLineFrom(cart, action.productId);
    case "clear":
      return clear();
    case "hydrate":
      return action.cart;
  }
}

/** localStorage is user-editable, so nothing is trusted until it passes this check. */
function parseStoredCart(raw: string): Cart | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const lines = (parsed as { lines?: unknown }).lines;
  if (!Array.isArray(lines)) return null;

  const valid = lines.every((line): line is CartLine => {
    if (typeof line !== "object" || line === null) return false;
    const l = line as Record<string, unknown>;
    return (
      typeof l.productId === "string" &&
      l.productId.length > 0 &&
      typeof l.slug === "string" &&
      typeof l.name === "string" &&
      typeof l.unitPrice === "number" &&
      Number.isInteger(l.unitPrice) &&
      l.unitPrice >= 0 &&
      typeof l.quantity === "number" &&
      Number.isInteger(l.quantity) &&
      l.quantity > 0
    );
  });
  if (!valid) return null;

  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.productId)) return null;
    seen.add(line.productId);
  }
  return { lines };
}

function readStoredCart(): Cart | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? null : parseStoredCart(raw);
  } catch {
    // Storage can throw outright (Safari private mode) or be disabled.
    return null;
  }
}

type CartContextValue = {
  cart: Cart;
  /**
   * False until the persisted cart has been read from localStorage. Components
   * that render cart contents must wait for it: the server has no localStorage,
   * so rendering a count before hydration shows "0" on the server and "3" in
   * the browser, which React reports as a hydration mismatch.
   */
  hydrated: boolean;
  addLine: (line: CartLine) => void;
  setQuantity: (productId: string, quantity: number) => void;
  removeLine: (productId: string) => void;
  clearCart: () => void;
  getLine: (productId: string) => CartLine | undefined;
  countLines: number;
  subtotalPaise: Paise;
};

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [{ cart, hydrated }, dispatch] = useReducer(reducer, undefined, () => ({
    cart: emptyCart(),
    hydrated: false,
  }));

  useEffect(() => {
    dispatch({ type: "hydrate", cart: readStoredCart() ?? emptyCart() });
  }, []);

  useEffect(() => {
    // Do not write the empty initial cart back over persisted state before hydration.
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cart));
    } catch {
      // Persistence is best-effort; the in-memory cart still works.
    }
  }, [cart, hydrated]);

  const addLine = useCallback((line: CartLine) => dispatch({ type: "add", line }), []);
  const setQuantity = useCallback(
    (productId: string, quantity: number) => dispatch({ type: "setQuantity", productId, quantity }),
    [],
  );
  const removeLine = useCallback((productId: string) => dispatch({ type: "remove", productId }), []);
  const clearCart = useCallback(() => dispatch({ type: "clear" }), []);

  const value = useMemo<CartContextValue>(
    () => ({
      cart,
      hydrated,
      addLine,
      setQuantity,
      removeLine,
      clearCart,
      getLine: (productId) => getLineFrom(cart, productId),
      countLines: countOf(cart),
      subtotalPaise: subtotalOf(cart),
    }),
    [cart, hydrated, addLine, setQuantity, removeLine, clearCart],
  );

  return <CartContext value={value}>{children}</CartContext>;
}

export function useCart(): CartContextValue {
  const value = useContext(CartContext);
  if (!value) throw new Error("useCart must be used within a CartProvider");
  return value;
}
