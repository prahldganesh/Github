/**
 * Shared storefront chrome: the header and footer every customer page renders.
 *
 * A Server Component - it holds no interactive state. The cart badge will be
 * added in Phase 4; for now the header is deliberately just identity and a way
 * back to the catalogue.
 */
import Link from "next/link";
import { CartLink } from "@/components/cart-link";
import { site } from "@/lib/site";

export function SiteHeader() {
  return (
    <header className="border-b border-slate-200">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          {site.name}
        </Link>
        <nav className="flex items-center gap-6 text-sm text-slate-600">
          <Link href="/products" className="hover:text-slate-900">
            Products
          </Link>
          <CartLink />
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-20 border-t border-slate-200">
      <div className="mx-auto max-w-5xl px-6 py-8 text-sm text-slate-500">
        <p>
          {site.name} &middot; {site.tagline}
        </p>
      </div>
    </footer>
  );
}
