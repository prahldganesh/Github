/**
 * Display labels for the database enums.
 *
 * The enum values (NEW, COD, PAID…) are the vocabulary of the code and the
 * database; these are the words shown to a human. Keeping the mapping in one
 * place means a status is never rendered as a raw SCREAMING_CASE string, and
 * adding a status is a compile error until it is given a label.
 *
 * `satisfies Record<Enum, string>` is what enforces that: it requires every
 * enum member to appear, so a new status cannot be silently forgotten.
 */
import type { OrderStatus, PaymentStatus, PaymentMethod } from "@/generated/prisma/enums";

export const ORDER_STATUS_LABELS = {
  NEW: "New",
  CONFIRMED: "Confirmed",
  PACKED: "Packed",
  SHIPPED: "Shipped",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
} satisfies Record<OrderStatus, string>;

export const PAYMENT_STATUS_LABELS = {
  PENDING: "Pending",
  PAID: "Paid",
  COD: "Cash on delivery",
  FAILED: "Failed",
  REFUNDED: "Refunded",
} satisfies Record<PaymentStatus, string>;

export const PAYMENT_METHOD_LABELS = {
  COD: "Cash on delivery",
  RAZORPAY: "Online (Razorpay)",
} satisfies Record<PaymentMethod, string>;
