/**
 * Home page - the storefront entry point.
 *
 * A Server Component that reads the catalogue and shows the newest few
 * products. `force-dynamic` for the same reason as /products: stock changes as
 * orders are placed, so a build-time snapshot would go stale.
 */
import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { ProductCard } from "@/components/product-card";
import { listCatalogue } from "@/lib/products/service";
import { site } from "@/lib/site";

export const dynamic = "force-dynamic";

export default async function Home() {
  const products = await listCatalogue();
  const featured = products.slice(0, 6);

  return (
    <>
      <SiteHeader />
      <main>
        <section className="mx-auto max-w-5xl px-6 py-16">
          <h1 className="text-4xl font-bold tracking-tight">{site.name}</h1>
          <p className="mt-4 max-w-prose text-lg text-slate-600">
            {site.description}
          </p>
          <Link
            href="/products"
            className="mt-8 inline-block rounded-md bg-slate-900 px-6 py-3 font-medium text-white"
          >
            Browse products
          </Link>
        </section>

        {featured.length > 0 && (
          <section className="mx-auto max-w-5xl px-6 pb-8">
            <div className="flex items-baseline justify-between">
              <h2 className="text-xl font-semibold tracking-tight">
                Latest arrivals
              </h2>
              <Link href="/products" className="text-sm text-slate-600 hover:text-slate-900">
                View all
              </Link>
            </div>
            <ul className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {featured.map((product) => (
                <li key={product.id}>
                  <ProductCard product={product} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
