"use client";

/**
 * The cart badge in the site header.
 *
 * A Client Component, so it must be rendered inside `CartProvider`. It renders
 * nothing until the cart is hydrated, to avoid a server/client mismatch: the
 * server has no localStorage, so it would render "0" and the browser "3".
 */
import Link from "next/link";
import { useCart } from "@/lib/cart/context";

export function CartLink() {
  const { countLines, hydrated } = useCart();

  return (
    <Link href="/cart" className="hover:text-slate-900">
      Cart
      {hydrated && countLines > 0 && (
        <span className="ml-1.5 rounded-full bg-slate-900 px-2 py-0.5 text-xs text-white">
          {countLines}
        </span>
      )}
    </Link>
  );
}
