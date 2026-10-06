/**
 * Product catalogue (/products).
 *
 * A Server Component: it reads the catalogue on the server and sends HTML. No
 * client JavaScript is needed to display a list of products.
 *
 * `export const dynamic = "force-dynamic"` is deliberate here. The catalogue
 * depends on stock, which changes as orders are placed. Next 16 would otherwise
 * prerender this at build time and serve a stale, possibly out-of-stock list.
 * Phase 15 can replace this with tag-based revalidation once product writes
 * exist to invalidate the cache.
 */
import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { ProductCard } from "@/components/product-card";
import { listCatalogue } from "@/lib/products/service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Products",
  description: "Browse everything we sell.",
};

export default async function ProductsPage() {
  const products = await listCatalogue();

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="text-3xl font-bold tracking-tight">Products</h1>
        <p className="mt-2 text-slate-600">
          {products.length === 0
            ? "Nothing here yet."
            : `${products.length} product${products.length === 1 ? "" : "s"} available.`}
        </p>

        {products.length === 0 ? (
          <EmptyCatalogue />
        ) : (
          <ul className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((product) => (
              <li key={product.id}>
                <ProductCard product={product} />
              </li>
            ))}
          </ul>
        )}
      </main>
      <SiteFooter />
    </>
  );
}

function EmptyCatalogue() {
  return (
    <div className="mt-8 rounded-lg border border-dashed border-slate-300 p-10 text-center">
      <p className="text-slate-600">No products are available right now.</p>
      <p className="mt-2 text-sm text-slate-500">
        An administrator can add products from the admin dashboard.
      </p>
    </div>
  );
}
