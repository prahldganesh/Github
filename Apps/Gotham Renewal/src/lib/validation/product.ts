/**
 * Product validation schemas (Phase 13 - admin product management).
 *
 * These schemas are the trust boundary for the admin product forms. The same
 * rules apply to creating and updating a product, so there is one schema and
 * the update path reuses it.
 *
 * THE MONEY RULE. The form asks the admin to type RUPEES, because that is how a
 * person thinks about a price. The database stores integer PAISE, because that
 * is the only way to do exact money (see src/lib/money.ts). The conversion
 * happens HERE, in the schema's transform, so no rupees ever reach the service
 * or the database. `rupeesToPaise` from the money module does the arithmetic.
 *
 * The rupee field is validated as a STRING first (a maximum of two decimal
 * places, no sign, no exponent). Coercing "1.234" straight to a number would
 * silently round it and store a price the admin did not type; rejecting it is
 * the honest behaviour.
 */
import { z } from "zod";
import { rupeesToPaise } from "@/lib/money";

/** ₹10,00,000. A guard against a fat-fingered extra zero, not a business cap. */
export const MAX_PRICE_RUPEES = 1_000_000;

/** A guard against a typo turning stock into a nonsense number. */
export const MAX_STOCK = 1_000_000;

/** The URL-safe slug grammar, exactly as CONTEXT.md describes it. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Turn arbitrary text into a slug-shaped string.
 *
 * Pure, so it can be unit-tested without a database. The schema already
 * enforces `SLUG_PATTERN`; this exists so the service can canonicalise an
 * input that arrives from a caller that skipped the schema (defence in depth),
 * and so the rule "lowercase, hyphens, no leading/trailing hyphen" lives in one
 * testable place.
 */
export function normaliseSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Validate a paise amount at the service boundary.
 *
 * Returns the amount when it is a positive whole number of paise, or null when
 * it is not. Pure. The schema has already converted rupees to paise; this is a
 * second, cheap guard against a direct caller handing the service 450.5 paise
 * or a negative price.
 */
export function normalisePricePaise(paise: number): number | null {
  return Number.isInteger(paise) && paise > 0 ? paise : null;
}

const nameField = z
  .string()
  .trim()
  .min(2, "name is too short")
  .max(200, "name is too long");

const slugField = z
  .string()
  .trim()
  .min(2, "slug is too short")
  .max(200, "slug is too long")
  .regex(SLUG_PATTERN, "slug must be lowercase letters, numbers and single hyphens");

const descriptionField = z
  .string()
  .trim()
  .max(5000, "description is too long")
  .optional()
  .default("");

// A positive rupee amount with at most two decimal places. Deliberately a
// string: see the money note at the top of this file.
const priceRupeesField = z
  .string()
  .trim()
  .min(1, "price is required")
  .regex(/^\d+(?:\.\d{1,2})?$/, "enter a price like 450 or 450.50")
  .transform((value) => Number(value))
  .refine((value) => value > 0, "price must be greater than zero")
  .refine(
    (value) => value <= MAX_PRICE_RUPEES,
    `price may not exceed ${MAX_PRICE_RUPEES} rupees`,
  );

const stockField = z
  .string()
  .trim()
  .min(1, "stock is required")
  .regex(/^\d+$/, "stock must be a whole number")
  .transform((value) => Number(value))
  .refine((value) => value <= MAX_STOCK, `stock may not exceed ${MAX_STOCK}`);

// Either a valid http(s) URL, or empty (no image).
const imageUrlField = z
  .union([z.url({ protocol: /^https?$/ }), z.literal("")])
  .optional()
  .default("");

// The form posts a checkbox: present means true, absent means false. The action
// turns that into a real boolean before the schema sees it.
const activeField = z.boolean().default(true);

/**
 * Create/update a product.
 *
 * The output object has `price` as an integer in paise and `imageUrl` as either
 * a URL string or null. It has no `priceRupees` field - the rupees value does
 * not leave this module.
 */
export const createProductSchema = z
  .object({
    name: nameField,
    slug: slugField,
    description: descriptionField,
    priceRupees: priceRupeesField,
    stock: stockField,
    imageUrl: imageUrlField,
    active: activeField,
  })
  .transform((data) => ({
    name: data.name,
    slug: data.slug,
    description: data.description,
    // Integer paise. The one place rupees become paise.
    price: rupeesToPaise(data.priceRupees),
    stock: data.stock,
    imageUrl: data.imageUrl === "" ? null : data.imageUrl,
    active: data.active,
  }));

export const updateProductSchema = createProductSchema;

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = CreateProductInput;
