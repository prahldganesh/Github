/**
 * Admin layout.
 *
 * Every admin page below this layout is protected. The guard is applied here in
 * the layout AND in each page's data access, because a layout's return value
 * does not stop a nested page from rendering in all cases - the layout renders
 * in parallel with the page. The authoritative check is the one inside the page
 * or action that touches data; this layout adds the navigation and a redirect.
 *
 * `robots: noindex` keeps the whole area out of search results.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth/guard";
import { logoutAction } from "@/lib/auth/actions";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  // The shop's own name, so the owner recognises the tab as theirs.
  title: { default: "Admin", template: `%s | ${site.name} Admin` },
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Redirects to /admin/login when there is no valid session.
  await requireAdmin();

  return (
    <div className="min-h-dvh bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <nav className="flex items-center gap-6 text-sm">
            <Link href="/admin" className="font-semibold tracking-tight">
              {site.name}
            </Link>
            <Link href="/admin/orders" className="text-slate-600 hover:text-slate-900">
              Orders
            </Link>
            <Link href="/admin/products" className="text-slate-600 hover:text-slate-900">
              Products
            </Link>
          </nav>

          <form action={logoutAction}>
            <button type="submit" className="text-sm text-slate-600 hover:text-slate-900">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
    </div>
  );
}
