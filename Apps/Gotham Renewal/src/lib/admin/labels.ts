/**
 * Human labels and colour tones for the values shown in the admin tables.
 *
 * The enum values (PENDING, SENT, PROCESSING…) are the vocabulary of the code
 * and the database; these are the words and colours a shopkeeper should see.
 * Keeping the mapping in one place means a status is never rendered as a raw
 * SCREAMING_CASE string, and adding a status becomes a compile error until it is
 * given a label - `satisfies Record<Enum, …>` enforces that.
 *
 * The tones are not decoration. They are the fastest way for the owner to see
 * that something needs attention: red means "a person must act", amber means
 * "in flight, don't touch it yet", green means "done".
 */
import type { NotificationStatus, NotificationType, RefundStatus } from "@/generated/prisma/enums";
import type { PillTone } from "@/components/admin/status-pill";

export const NOTIFICATION_STATUS_LABELS = {
  PENDING: "Pending",
  SENT: "Sent",
  FAILED: "Failed",
} satisfies Record<NotificationStatus, string>;

export const NOTIFICATION_STATUS_TONES = {
  // Still queued - normal, the worker will get to it.
  PENDING: "neutral",
  SENT: "good",
  // A human has to look: retries are exhausted or the failure was permanent.
  FAILED: "bad",
} satisfies Record<NotificationStatus, PillTone>;

export const REFUND_STATUS_LABELS = {
  PENDING: "Pending",
  PROCESSING: "In progress",
  SUCCEEDED: "Refunded",
  FAILED: "Failed",
} satisfies Record<RefundStatus, string>;

export const REFUND_STATUS_TONES = {
  PENDING: "neutral",
  // In progress is amber, not red: the money may already be moving, so this is
  // "do not retry, reconcile instead" rather than "something is wrong".
  PROCESSING: "warn",
  SUCCEEDED: "good",
  FAILED: "bad",
} satisfies Record<RefundStatus, PillTone>;

export const NOTIFICATION_TYPE_LABELS = {
  ORDER_ALERT_BUSINESS: "New order → owner",
  ORDER_CONFIRMED_CUSTOMER: "Confirmed → customer",
  ORDER_PACKED_CUSTOMER: "Packed → customer",
  ORDER_SHIPPED_CUSTOMER: "Shipped → customer",
  ORDER_DELIVERED_CUSTOMER: "Delivered → customer",
} satisfies Record<NotificationType, string>;
