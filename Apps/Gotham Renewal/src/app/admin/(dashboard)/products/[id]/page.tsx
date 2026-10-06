/**
 * Edit product (/admin/products/[id]).
 *
 * The main form edits every writable field; the slug is shown read-only because
 * CONTEXT.md says a Slug is the product's public address and may not change once
 * published (the server would still refuse a collision). Below it are two
 * separate, narrow forms: enable/disable, and a quick absolute stock set.
 *
 * The price field is prefilled in RUPEES, converted from the stored paise. The
 * form posts rupees back and the server converts again on the way in.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/guard";
import { ImageUploader } from "@/components/admin/image-uploader";
import {
  setProductActiveAction,
  setStockAction,
  updateProductAction,
} from "@/app/admin/product-actions";
import { getProductForAdmin } from "@/lib/products/management";
import { formatPaise } from "@/lib/money";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; updated?: string; created?: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  return { title: `Product ${id.slice(0, 8)}` };
}

/** Paise -> a plain rupee string for the form, e.g. 45050 -> "450.50". */
function rupeesForForm(paise: number): string {
  return (paise / 100).toFixed(2);
}

export default async function AdminProductDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { error, updated, created } = await searchParams;
  await requireAdmin();

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  if (!isUuid) notFound();

  const product = await getProductForAdmin(id);
  if (!product) notFound();

  return (
    <div>
      <nav className="text-sm text-slate-500">
        <Link href="/admin/products" className="hover:text-slate-900">
          Products
        </Link>
        <span className="mx-2">/</span>
        <span className="text-slate-900">{product.name}</span>
      </nav>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{product.name}</h1>
        <span
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            product.active ? "bg-green-100 text-green-800" : "bg-slate-100 text-slate-700"
          }`}
        >
          {product.active ? "Active" : "Disabled"}
        </span>
        <span className="text-sm text-slate-500">{formatPaise(product.price)}</span>
      </div>

      {error && (
        <p role="alert" className="mt-6 rounded-md bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}
      {created && (
        <p role="status" className="mt-6 rounded-md bg-green-50 p-3 text-sm text-green-800">
          Product created.
        </p>
      )}
      {updated && (
        <p role="status" className="mt-6 rounded-md bg-green-50 p-3 text-sm text-green-800">
          Product updated.
        </p>
      )}

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <form
            action={updateProductAction}
            className="space-y-5 rounded-lg border border-slate-200 bg-white p-5"
          >
            <input type="hidden" name="id" value={product.id} />
            {/* The version this form was rendered from. The server refuses the
                save if the product changed since, rather than overwriting a
                concurrent edit or a sale. */}
            <input type="hidden" name="version" value={product.version} />

            <Field label="Name">
              <input
                name="name"
                required
                minLength={2}
                maxLength={200}
                defaultValue={product.name}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </Field>

            <Field label="Slug" hint="The public address. Shown read-only; it may not change once published.">
              <input
                name="slug"
                required
                readOnly
                defaultValue={product.slug}
                className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-500"
              />
            </Field>

            <Field label="Description">
              <textarea
                name="description"
                rows={4}
                maxLength={5000}
                defaultValue={product.description}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </Field>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <Field label="Price (₹)" hint="Rupees, up to two decimal places.">
                <input
                  name="priceRupees"
                  required
                  inputMode="decimal"
                  defaultValue={rupeesForForm(product.price)}
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
                  defaultValue={product.stock}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
              </Field>
            </div>

            <Field label="Image URL" hint="Optional. Must start with http:// or https://.">
              <input
                id="product-image-url"
                name="imageUrl"
                type="url"
                defaultValue={product.imageUrl ?? ""}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </Field>

            {/* Additive: an admin can still paste a URL. If storage is not
                configured the uploader reports it and this field is unaffected. */}
            <ImageUploader targetInputId="product-image-url" />

            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                name="active"
                type="checkbox"
                defaultChecked={product.active}
                className="h-4 w-4"
              />
              Active (visible in the catalogue)
            </label>

            <div className="flex items-center gap-3 border-t border-slate-100 pt-5">
              <button
                type="submit"
                className="rounded-md bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
              >
                Save changes
              </button>
            </div>
          </form>
        </div>

        <div className="space-y-6">
          <section className="rounded-lg border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Stock
            </h2>
            <p className="mt-3 text-sm text-slate-600">
              Current stock: <span className="font-medium">{product.stock}</span>
            </p>
            <form action={setStockAction} className="mt-3 flex items-end gap-2">
              <input type="hidden" name="id" value={product.id} />
              <input type="hidden" name="version" value={product.version} />
              <label className="flex-1">
                <span className="mb-1 block text-xs text-slate-500">Set stock to</span>
                <input
                  name="stock"
                  required
                  type="number"
                  min={0}
                  step={1}
                  defaultValue={product.stock}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
              <button
                type="submit"
                className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Set
              </button>
            </form>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Availability
            </h2>
            <p className="mt-3 text-sm text-slate-600">
              {product.active
                ? "This product is visible in the catalogue and orderable."
                : "This product is hidden from the catalogue. Historical orders keep it."}
            </p>
            <form action={setProductActiveAction} className="mt-3">
              <input type="hidden" name="id" value={product.id} />
              <input type="hidden" name="version" value={product.version} />
              <input type="hidden" name="active" value={product.active ? "false" : "true"} />
              <button
                type="submit"
                className={`w-full rounded-md px-4 py-2 text-sm font-medium ${
                  product.active
                    ? "border border-red-300 text-red-700 hover:bg-red-50"
                    : "bg-slate-900 text-white hover:bg-slate-800"
                }`}
              >
                {product.active ? "Disable product" : "Enable product"}
              </button>
            </form>
            <p className="mt-3 text-xs text-slate-400">
              Products are never deleted, so past orders stay intact.
            </p>
          </section>
        </div>
      </div>
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
