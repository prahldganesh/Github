/**
 * Notification payloads.
 *
 * The bridge between an Order and the WhatsApp template parameters. It runs at
 * ENQUEUE time, inside the order transaction, so the payload is a snapshot:
 * a retry hours later sends what was intended when the order was placed, even
 * if a product was renamed or a template changed in between.
 *
 * It is deliberately pure - an order-shaped object in, JSON out - so it can be
 * tested without a database, and the worker never needs to re-read the order.
 */
import { env } from "@/lib/env";
import { newOrderAlertParameters, NEW_ORDER_ALERT } from "@/lib/whatsapp/templates";
import type { TemplateParameter } from "@/lib/whatsapp/types";
import { PAYMENT_STATUS_LABELS } from "@/lib/orders/labels";
import type { OrderStatus, PaymentStatus } from "@/generated/prisma/enums";

export type OrderAlertPayload = {
  templateName: string;
  languageCode: string;
  to: string;
  bodyParameters: TemplateParameter[];
};

/** The fields of an order the alert needs. Structural, not the Prisma type. */
export type OrderAlertSource = {
  orderNumber: string;
  customerName: string;
  total: number;
  paymentStatus: PaymentStatus;
  customerPhone: string;
};

/**
 * Build the Order Alert payload for the business owner.
 *
 * The recipient and the display URL come from configuration, not from the
 * order, so a misconfigured environment fails loudly at enqueue time rather
 * than silently sending to the wrong number.
 */
export function buildOrderAlertPayload(order: OrderAlertSource): OrderAlertPayload {
  const config = env();

  const recipient = config.ORDER_NOTIFICATION_NUMBER;
  if (!recipient) {
    throw new Error(
      "ORDER_NOTIFICATION_NUMBER is not set, so there is no one to notify about an order.",
    );
  }

  // The template's payment label: "PAID" or "COD". Falls back to the raw status
  // so an unexpected value is visible in the message rather than blank.
  const paymentLabel = PAYMENT_STATUS_LABELS[order.paymentStatus] ?? order.paymentStatus;

  return {
    templateName: NEW_ORDER_ALERT.name,
    languageCode: NEW_ORDER_ALERT.languageCode,
    to: recipient,
    // `newOrderAlertParameters` owns the ordering and the paise formatting, so
    // the payload cannot drift from the template body.
    bodyParameters: [
      ...newOrderAlertParameters({
        orderNumber: order.orderNumber,
        customerName: order.customerName,
        totalPaise: order.total,
        paymentLabel: paymentLabel.toUpperCase(),
        orderUrl: `${config.APP_BASE_URL}/admin/orders`,
      }),
    ],
  };
}

/** Narrow the JSON read back out of the database. */
export function isOrderAlertPayload(value: unknown): value is OrderAlertPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<OrderAlertPayload>;
  return (
    typeof candidate.templateName === "string" &&
    typeof candidate.languageCode === "string" &&
    typeof candidate.to === "string" &&
    Array.isArray(candidate.bodyParameters)
  );
}

export type { OrderStatus };
