/**
 * New product (/admin/products/new).
 *
 * A Server Component form posting to `createProductAction`. The action takes
 * `FormData`, so no Client Component or `useActionState` is needed; feedback is
 * read back from `searchParams`.
 *
 * The price field is in RUPEES. The server action validates it and converts it
 * to paise - the browser never supplies a paise amount.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth/guard";
import { createProductAction } from "@/app/admin/product-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "New product" };

type PageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function AdminNewProductPage({ searchParams }: PageProps) {
  const { error } = await searchParams;
  await requireAdmin();

  return (
    <div>
      <nav className="text-sm text-slate-500">
        <Link href="/admin/products" className="hover:text-slate-900">
          Products
        </Link>
        <span className="mx-2">/</span>
        <span className="text-slate-900">New</span>
      </nav>

      <h1 className="mt-4 text-2xl font-bold tracking-tight">New product</h1>

      {error && (
        <p role="alert" className="mt-6 rounded-md bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}

      <form action={createProductAction} className="mt-8 max-w-2xl space-y-5">
        <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-5">
          <Field label="Name">
            <input
              name="name"
              required
              minLength={2}
              maxLength={200}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </Field>

          <Field label="Slug" hint="Lowercase letters, numbers and hyphens. Used in /products/[slug].">
            <input
              name="slug"
              required
              minLength={2}
              maxLength={200}
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              placeholder="coir-doormat"
              className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
            />
          </Field>

          <Field label="Description">
            <textarea
              name="description"
              rows={4}
              maxLength={5000}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </Field>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field label="Price (₹)" hint="Rupees, up to two decimal places.">
              <input
                name="priceRupees"
                required
                inputMode="decimal"
                placeholder="450.50"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </Field>

            <Field label="Stock">
              <input
                name="stock"
                required
                type="number"
                min={0}
                step={1}
                defaultValue={0}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </Field>
          </div>

          <Field label="Image URL" hint="Optional. Must start with http:// or https://.">
            <input
              name="imageUrl"
              type="url"
              placeholder="https://cdn.example.com/product.png"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </Field>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input name="active" type="checkbox" defaultChecked className="h-4 w-4" />
            Active (visible in the catalogue)
          </label>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            Create product
          </button>
          <Link href="/admin/products" className="text-sm text-slate-600 hover:text-slate-900">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}
