/**
 * WhatsApp template shapes.
 *
 * This file owns the template NAMES, language codes, body wording, and the
 * mapping from a domain-ish object to the ordered `parameters` array. It
 * produces payload data; it never sends (see `client.ts`). If Meta rewords a
 * template, only this file and the Meta Business Manager template change.
 *
 * The constants below are the single source of truth for the body text, so the
 * thing created in WhatsApp Manager and the thing in code cannot drift.
 *
 * Environment-agnostic: no `server-only`, no Prisma. Money is integer paise and
 * formatted with `@/lib/money.formatPaise`.
 */
import { formatPaise } from "@/lib/money";
import type { NewOrderAlertInput, TemplateParameter } from "./types";

export type TemplateDefinition = {
  name: string;
  languageCode: string;
  /** Category to select in WhatsApp Manager. Orders are transactional. */
  category: "utility";
  /**
   * Body text as it must appear in WhatsApp Manager. `{{name}}` placeholders
   * are named parameters (`parameter_format: "named"`).
   */
  body: string;
  /** Parameter names, in body order. The mapper below emits these exactly. */
  parameterNames: readonly string[];
};

/**
 * Order Alert to the business owner. UTILITY, `parameter_format: "named"`.
 *
 * Create this in WhatsApp Manager -> Message templates with this body
 * (see docs/research/whatsapp-cloud-api.md §3):
 *
 *   New order {{order_number}}
 *   Customer: {{customer_name}}
 *   Amount: {{amount}}
 *   Payment: {{payment_status}}
 *   View order: {{order_url}}
 *
 * `amount` is formatted with `formatPaise` and INCLUDES the rupee symbol, so
 * the body has no "Rs." prefix - keeping it in one place. The warning from the
 * research stands: keep this non-promotional or Meta re-categorises it as
 * MARKETING. The recipient is our own staff, not the buyer; utility is the
 * correct classification on content.
 */
export const NEW_ORDER_ALERT: TemplateDefinition = {
  name: "new_order_alert",
  languageCode: "en_IN",
  category: "utility",
  body: [
    "New order {{order_number}}",
    "Customer: {{customer_name}}",
    "Amount: {{amount}}",
    "Payment: {{payment_status}}",
    "View order: {{order_url}}",
  ].join("\n"),
  parameterNames: [
    "order_number",
    "customer_name",
    "amount",
    "payment_status",
    "order_url",
  ],
};

/**
 * Customer Notification for an Order's progress. One template covers all four
 * updates; `status` is CONFIRMED | PACKED | SHIPPED | DELIVERED and `note` is
 * e.g. tracking info. Designed for, but not yet sent.
 *
 * Body to create in WhatsApp Manager:
 *
 *   Update on order {{order_number}}
 *   Status: {{status}}
 *   {{note}}
 */
export const ORDER_STATUS_UPDATE: TemplateDefinition = {
  name: "order_status_update",
  languageCode: "en_IN",
  category: "utility",
  body: [
    "Update on order {{order_number}}",
    "Status: {{status}}",
    "{{note}}",
  ].join("\n"),
  parameterNames: ["order_number", "status", "note"],
};

function text(name: string, value: string): TemplateParameter {
  return { type: "text", parameter_name: name, text: value };
}

/**
 * Map an order-ish object to the `new_order_alert` body parameters, in body
 * order. `paymentLabel` becomes the `payment_status` parameter (e.g. "PAID",
 * "COD"). The amount is formatted from integer paise, symbol included.
 */
export function newOrderAlertParameters(
  order: NewOrderAlertInput,
): TemplateParameter[] {
  return [
    text("order_number", order.orderNumber),
    text("customer_name", order.customerName),
    text("amount", formatPaise(order.totalPaise)),
    text("payment_status", order.paymentLabel),
    text("order_url", order.orderUrl),
  ];
}

export type OrderStatusUpdateInput = {
  orderNumber: string;
  status: "CONFIRMED" | "PACKED" | "SHIPPED" | "DELIVERED";
  note: string;
};

/** Map an order-progress object to the `order_status_update` body parameters. */
export function orderStatusUpdateParameters(
  update: OrderStatusUpdateInput,
): TemplateParameter[] {
  return [
    text("order_number", update.orderNumber),
    text("status", update.status),
    text("note", update.note),
  ];
}
