/**
 * Product card for the catalogue grid.
 *
 * A Server Component. It renders money with `formatPaise`, so the price arrives
 * from the database as integer paise and is only ever formatted for display.
 */
import Link from "next/link";
import { formatPaise } from "@/lib/money";
import type { ProductSummary } from "@/lib/products/repository";

export function ProductCard({ product }: { product: ProductSummary }) {
  const soldOut = product.stock <= 0;

  return (
    <Link
      href={`/products/${product.slug}`}
      className="group rounded-lg border border-slate-200 transition hover:border-slate-400"
    >
      <div className="aspect-square overflow-hidden rounded-t-lg bg-slate-100">
        {product.imageUrl ? (
          // Images come from an external CDN later; plain <img> avoids
          // configuring next/image domains before the storage choice is wired.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.imageUrl}
            alt={product.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-slate-400">
            No image
          </div>
        )}
      </div>

      <div className="p-4">
        <h3 className="font-medium text-slate-900 group-hover:underline">
          {product.name}
        </h3>
        <p className="mt-1 text-slate-700">{formatPaise(product.price)}</p>
        <p className="mt-2 text-xs text-slate-500">
          {soldOut ? "Out of stock" : `${product.stock} in stock`}
        </p>
      </div>
    </Link>
  );
}
