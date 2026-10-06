"use server";

/**
 * Admin server actions for products (Phase 13).
 *
 * Every action calls `assertAdmin()` FIRST. Server actions are individually
 * addressable POST endpoints, so an action that trusts "the page was behind a
 * guard" is callable by anyone who knows its id. The check must be inside the
 * action, not inferred from the page. This mirrors src/app/admin/actions.ts.
 *
 * Signature note: these take `FormData` only, because they are used as plain
 * `<form action={...}>` from Server Components. Errors are reported by
 * redirecting back with a query parameter, which keeps the pages Server
 * Components and avoids `useActionState` (which would force a Client Component).
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { assertAdmin } from "@/lib/auth/guard";
import {
  createProduct,
  setProductActive,
  setStock,
  updateProduct,
  messageForProblem,
} from "@/lib/products/management";
import { createProductSchema } from "@/lib/validation/product";
import { fieldErrors } from "@/lib/validation/order";
import type { ZodError } from "zod";

/** Build the schema input from a product form's FormData. */
function productInputFromForm(formData: FormData) {
  return {
    name: String(formData.get("name") ?? ""),
    slug: String(formData.get("slug") ?? ""),
    description: String(formData.get("description") ?? ""),
    priceRupees: String(formData.get("priceRupees") ?? ""),
    stock: String(formData.get("stock") ?? ""),
    imageUrl: String(formData.get("imageUrl") ?? ""),
    // An unchecked checkbox is simply absent from the body.
    active: formData.get("active") === "on",
  };
}

/** The first field error, for the query-string feedback. */
function firstFieldError(error: ZodError): string {
  return Object.values(fieldErrors(error))[0] ?? "The product form was invalid.";
}

/**
 * Refresh both admin and storefront views after any product write.
 *
 * Disabling, re-stocking or repricing a product changes the catalogue, so the
 * storefront pages are invalidated too - not just /admin/products.
 */
function revalidateProductViews(): void {
  revalidatePath("/admin/products");
  revalidatePath("/products");
  // Dynamic segments need the pattern plus an explicit type.
  revalidatePath("/products/[slug]", "page");
}

export async function createProductAction(formData: FormData): Promise<void> {
  try {
    await assertAdmin();
  } catch {
    redirect("/admin/login");
  }

  const parsed = createProductSchema.safeParse(productInputFromForm(formData));

  // A malformed submission is a bug or a forgery, not a user error.
  if (!parsed.success) {
    redirect(`/admin/products/new?error=${encodeURIComponent(firstFieldError(parsed.error))}`);
  }

  const result = await createProduct(parsed.data);

  if (!result.ok) {
    redirect(`/admin/products/new?error=${encodeURIComponent(messageForProblem(result.problem))}`);
  }

  revalidateProductViews();
  redirect(`/admin/products/${result.product.id}?created=1`);
}


/**
 * The version the form was rendered from.
 *
 * Every product edit form carries this as a hidden field. It is what makes a
 * stale save detectable: the server only writes if the row still has this
 * version. A missing or malformed value is treated as a client that did not
 * send one, which cannot be trusted to be current - so it is rejected rather
 * than defaulted to 0 (which would silently defeat the guard).
 */
function versionFromForm(formData: FormData): number | null {
  const raw = String(formData.get("version") ?? "");
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

export async function updateProductAction(formData: FormData): Promise<void> {
  try {
    await assertAdmin();
  } catch {
    redirect("/admin/login");
  }

  const id = String(formData.get("id") ?? "");
  if (!id) {
    redirect(`/admin/products?error=${encodeURIComponent("A product id is required.")}`);
  }

  const parsed = createProductSchema.safeParse(productInputFromForm(formData));

  if (!parsed.success) {
    redirect(
      `/admin/products/${id}?error=${encodeURIComponent(firstFieldError(parsed.error))}`,
    );
  }

  const version = versionFromForm(formData);
  if (version === null) {
    redirect(
      `/admin/products/${id}?error=${encodeURIComponent("This form is out of date. Reload the page and try again.")}`,
    );
  }

  const result = await updateProduct(id, parsed.data, version);

  if (!result.ok) {
    redirect(
      `/admin/products/${id}?error=${encodeURIComponent(messageForProblem(result.problem))}`,
    );
  }

  revalidateProductViews();
  revalidatePath(`/admin/products/${id}`);
  redirect(`/admin/products/${id}?updated=1`);
}

export async function setProductActiveAction(formData: FormData): Promise<void> {
  try {
    await assertAdmin();
  } catch {
    redirect("/admin/login");
  }

  const id = String(formData.get("id") ?? "");
  const active = String(formData.get("active") ?? "");

  if (!id || (active !== "true" && active !== "false")) {
    redirect(`/admin/products?error=${encodeURIComponent("Invalid active change.")}`);
  }

  const version = versionFromForm(formData);
  if (version === null) {
    redirect(
      `/admin/products/${id}?error=${encodeURIComponent("This form is out of date. Reload the page and try again.")}`,
    );
  }

  const result = await setProductActive(id, active === "true", version);

  if (!result.ok) {
    redirect(
      `/admin/products/${id}?error=${encodeURIComponent(messageForProblem(result.problem))}`,
    );
  }

  revalidateProductViews();
  revalidatePath(`/admin/products/${id}`);
  redirect(`/admin/products/${id}?updated=1`);
}

export async function setStockAction(formData: FormData): Promise<void> {
  try {
    await assertAdmin();
  } catch {
    redirect("/admin/login");
  }

  const id = String(formData.get("id") ?? "");
  const raw = String(formData.get("stock") ?? "");

  if (!id || !/^\d+$/.test(raw)) {
    redirect(
      `/admin/products/${id}?error=${encodeURIComponent("Stock must be a whole number of zero or more.")}`,
    );
  }

  const version = versionFromForm(formData);
  if (version === null) {
    redirect(
      `/admin/products/${id}?error=${encodeURIComponent("This form is out of date. Reload the page and try again.")}`,
    );
  }

  const result = await setStock(id, Number(raw), version);

  if (!result.ok) {
    redirect(
      `/admin/products/${id}?error=${encodeURIComponent(messageForProblem(result.problem))}`,
    );
  }

  revalidateProductViews();
  revalidatePath(`/admin/products/${id}`);
  redirect(`/admin/products/${id}?updated=1`);
}
