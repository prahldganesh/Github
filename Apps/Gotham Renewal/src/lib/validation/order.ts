/**
 * Request validation schemas.
 *
 * Every value that crosses a trust boundary is validated here before it reaches
 * a service. Two rules shape the order schema:
 *
 *  1. The browser sends ONLY product ids and quantities. There is no `price`,
 *     no `total`, no `paymentStatus` field to accept - a schema that does not
 *     have the field cannot be fooled into reading one. Anything extra in the
 *     body is stripped (Zod objects ignore unknown keys by default).
 *  2. Quantities are bounded, so a request cannot ask for a million units
 *     "to see what happens".
 */
import { z } from "zod";

export const MAX_QUANTITY_PER_LINE = 20;
export const MAX_LINES_PER_ORDER = 50;

export const orderItemInputSchema = z.object({
  productId: z.uuid("productId must be a UUID"),
  quantity: z.coerce
    .number()
    .int("quantity must be a whole number")
    .min(1, "quantity must be at least 1")
    .max(MAX_QUANTITY_PER_LINE, `quantity may not exceed ${MAX_QUANTITY_PER_LINE}`),
});

/**
 * Indian mobile numbers, loosely: 10 digits starting 6-9, with an optional +91
 * or 0 prefix, and optional spaces/dashes. Stored normalised to digits.
 */
const phoneSchema = z
  .string()
  .trim()
  .min(10, "phone number is too short")
  .max(20, "phone number is too long")
  .transform((value) => value.replace(/[\s-]/g, ""))
  .refine((value) => /^(\+?91)?[6-9]\d{9}$/.test(value.replace(/^0+/, "")), {
    message: "enter a valid 10-digit Indian mobile number",
  })
  .transform((value) => {
    const digits = value.replace(/\D/g, "");
    // Normalise to the last 10 digits so +91/0 variants are consistent.
    return digits.slice(-10);
  });

const pincodeSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d{5}$/, "enter a valid 6-digit PIN code");

const nameSchema = z
  .string()
  .trim()
  .min(2, "name is too short")
  .max(120, "name is too long");

export const createOrderSchema = z.object({
  customer: z.object({
    name: nameSchema,
    phone: phoneSchema,
    email: z.union([z.email("enter a valid email address"), z.literal("")]).optional(),
    address: z.string().trim().min(10, "address is too short").max(500, "address is too long"),
    city: z.string().trim().min(2, "city is too short").max(100, "city is too long"),
    state: z.string().trim().min(2, "state is too short").max(100, "state is too long"),
    pincode: pincodeSchema,
  }),
  paymentMethod: z.enum(["COD", "RAZORPAY"]),
  items: z
    .array(orderItemInputSchema)
    .min(1, "an order must contain at least one item")
    .max(MAX_LINES_PER_ORDER, `an order may not contain more than ${MAX_LINES_PER_ORDER} lines`),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

/**
 * Turn a Zod error into a flat, client-safe field map.
 *
 * Never returns a stack trace or internal path, just `field -> message`.
 */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".");
    if (!out[path]) out[path] = issue.message;
  }
  return out;
}
