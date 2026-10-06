"use client";

/**
 * Cart page (/cart).
 *
 * Entirely client-side: the cart lives in localStorage, not the database. The
 * totals shown here are a convenience - checkout recomputes everything on the
 * server and the server's numbers win.
 *
 * Note what is NOT here: no price is ever sent anywhere. This page renders the
 * cart and links to checkout.
 */
import Link from "next/link";
import { useCart } from "@/lib/cart/context";
import { formatPaise } from "@/lib/money";

export default function CartPage() {
  const { cart, hydrated, setQuantity, removeLine, subtotalPaise, countLines } = useCart();

  // The server cannot know the cart, so render nothing until hydration is done.
  if (!hydrated) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-2xl font-bold tracking-tight">Your cart</h1>
        <p className="mt-4 text-slate-500">Loading your cart…</p>
      </main>
    );
  }

  if (countLines === 0) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-2xl font-bold tracking-tight">Your cart</h1>
        <p className="mt-4 text-slate-600">Your cart is empty.</p>
        <Link
          href="/products"
          className="mt-6 inline-block rounded-md bg-slate-900 px-6 py-3 font-medium text-white"
        >
          Browse products
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-bold tracking-tight">Your cart</h1>

      <ul className="mt-8 divide-y divide-slate-200 border-y border-slate-200">
        {cart.lines.map((line) => (
          <li key={line.productId} className="flex items-center gap-4 py-4">
            <div className="min-w-0 flex-1">
              <Link href={`/products/${line.slug}`} className="font-medium hover:underline">
                {line.name}
              </Link>
              <p className="text-sm text-slate-500">{formatPaise(line.unitPrice)} each</p>
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-600">
              <span className="sr-only">Quantity for {line.name}</span>
              <select
                value={line.quantity}
                onChange={(event) => setQuantity(line.productId, Number(event.target.value))}
                className="rounded-md border border-slate-300 px-2 py-1"
              >
                {Array.from({ length: 20 }, (_, index) => index + 1).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>

            <div className="w-24 text-right font-medium">
              {formatPaise(line.unitPrice * line.quantity)}
            </div>

            <button
              type="button"
              onClick={() => removeLine(line.productId)}
              className="text-sm text-slate-500 hover:text-red-600"
              aria-label={`Remove ${line.name}`}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-6 flex items-center justify-between">
        <span className="text-slate-600">Subtotal</span>
        <span className="text-lg font-semibold">{formatPaise(subtotalPaise)}</span>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        Shipping is calculated at checkout.
      </p>

      <Link
        href="/checkout"
        className="mt-8 block rounded-md bg-slate-900 px-6 py-3 text-center font-medium text-white"
      >
        Proceed to checkout
      </Link>
    </main>
  );
}
