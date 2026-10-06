/**
 * Product detail page (/products/[slug]) - Phase 3.
 *
 * Server Component. Two things worth noting about Next 16 here:
 *
 *  - `params` is a Promise and must be awaited. In Next 15 it could still be read
 *    synchronously; that compatibility was removed in 16.
 *  - `notFound()` is the way to render a 404. It throws a special signal that
 *    Next catches. We call it for a missing OR inactive product, so a disabled
 *    product is indistinguishable from one that never existed.
 *
 * The "Add to cart" control is a Client Component (a cart needs browser state),
 * added in Phase 4. This page renders the product itself, server-side.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { AddToCart } from "@/components/add-to-cart";
import { getProductBySlug } from "@/lib/products/service";
import { formatPaise } from "@/lib/money";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  if (!product) return { title: "Product not found" };
  return {
    title: product.name,
    description: product.description || undefined,
  };
}

export default async function ProductPage({ params }: PageProps) {
  const { slug } = await params;
  const product = await getProductBySlug(slug);

  if (!product) notFound();

  const soldOut = product.stock <= 0;

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-5xl px-6 py-10">
        <nav className="text-sm text-slate-500">
          <Link href="/products" className="hover:text-slate-900">
            Products
          </Link>
          <span className="mx-2">/</span>
          <span className="text-slate-900">{product.name}</span>
        </nav>

        <div className="mt-6 grid grid-cols-1 gap-10 md:grid-cols-2">
          <div className="aspect-square overflow-hidden rounded-lg bg-slate-100">
            {product.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={product.imageUrl}
                alt={product.name}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-slate-400">
                No image
              </div>
            )}
          </div>

          <div>
            <h1 className="text-3xl font-bold tracking-tight">{product.name}</h1>
            <p className="mt-3 text-2xl text-slate-900">
              {formatPaise(product.price)}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              {soldOut ? "Out of stock" : `In stock: ${product.stock}`}
            </p>

            {product.description && (
              <p className="mt-6 whitespace-pre-line text-slate-700">
                {product.description}
              </p>
            )}

            <div className="mt-8">
              <AddToCart
                product={{
                  id: product.id,
                  slug: product.slug,
                  name: product.name,
                  price: product.price,
                  stock: product.stock,
                }}
              />
            </div>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
