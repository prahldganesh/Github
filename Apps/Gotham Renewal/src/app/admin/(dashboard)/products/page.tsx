/**
 * Admin product list (/admin/products).
 *
 * A table of every product, active or not, with its price, stock and active
 * state, each linking to its edit page. Inactive products are shown here (the
 * admin must be able to find and re-enable them) even though the storefront
 * hides them.
 *
 * The guard is called here too - see the layout comment for why the page must
 * not rely on the layout.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth/guard";
import { listProductsForAdmin } from "@/lib/products/management";
import { formatPaise } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Products" };

export default async function AdminProductsPage() {
  await requireAdmin();
  const products = await listProductsForAdmin();

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Products</h1>
        <Link
          href="/admin/products/new"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          New product
        </Link>
      </div>

      {products.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed border-slate-300 p-10 text-center text-slate-600">
          No products yet. Add the first one with “New product”.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Slug</th>
                <th className="px-4 py-3 text-right">Price</th>
                <th className="px-4 py-3 text-right">Stock</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {products.map((product) => (
                <tr key={product.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/products/${product.id}`}
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {product.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">{product.slug}</td>
                  <td className="px-4 py-3 text-right font-medium">{formatPaise(product.price)}</td>
                  <td className="px-4 py-3 text-right text-slate-600">{product.stock}</td>
                  <td className="px-4 py-3">
                    <ActivePill active={product.active} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ActivePill({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
        active ? "bg-green-100 text-green-800" : "bg-slate-100 text-slate-700"
      }`}
    >
      {active ? "Active" : "Disabled"}
    </span>
  );
}
