/**
 * 404 page. Rendered by `notFound()` calls, e.g. an unknown or inactive product
 * slug. A Server Component by default.
 */
import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-5xl px-6 py-24 text-center">
        <h1 className="text-2xl font-semibold">Page not found</h1>
        <p className="mt-3 text-slate-600">
          The page you were looking for is not here.
        </p>
        <Link
          href="/products"
          className="mt-8 inline-block rounded-md bg-slate-900 px-6 py-3 font-medium text-white"
        >
          Browse products
        </Link>
      </main>
      <SiteFooter />
    </>
  );
}
