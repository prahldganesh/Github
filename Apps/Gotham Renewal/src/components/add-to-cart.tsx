"use client";

/**
 * Add-to-cart control for the product detail page.
 *
 * A Client Component because it needs browser state (the cart). It sends the
 * product id and quantity only - never a price - because the server is the
 * authority on money.
 */
import { useState } from "react";
import { useCart } from "@/lib/cart/context";
import type { CartLine } from "@/lib/cart/types";

const MAX_PER_LINE = 20;

export function AddToCart({
  product,
}: {
  product: { id: string; slug: string; name: string; price: number; stock: number };
}) {
  const { addLine } = useCart();
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState(false);

  const soldOut = product.stock <= 0;
  const maxQuantity = Math.min(MAX_PER_LINE, product.stock);

  function handleAdd() {
    const line: CartLine = {
      productId: product.id,
      slug: product.slug,
      name: product.name,
      unitPrice: product.price,
      quantity,
    };
    addLine(line);
    setAdded(true);
    // Reset the confirmation after a moment so the page does not look stuck.
    window.setTimeout(() => setAdded(false), 2000);
  }

  if (soldOut) {
    return (
      <button
        type="button"
        disabled
        className="w-full cursor-not-allowed rounded-md bg-slate-300 px-6 py-3 font-medium text-white sm:w-auto"
      >
        Out of stock
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <label className="flex items-center gap-2 text-sm text-slate-600">
        Qty
        <select
          value={quantity}
          onChange={(event) => setQuantity(Number(event.target.value))}
          className="rounded-md border border-slate-300 px-2 py-1.5"
          aria-label="Quantity"
        >
          {Array.from({ length: maxQuantity }, (_, index) => index + 1).map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        onClick={handleAdd}
        className="w-full rounded-md bg-slate-900 px-6 py-3 font-medium text-white hover:bg-slate-800 sm:w-auto"
      >
        {added ? "Added to cart" : "Add to cart"}
      </button>
    </div>
  );
}
