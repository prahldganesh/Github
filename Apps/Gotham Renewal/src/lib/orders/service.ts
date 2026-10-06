/**
 * Order service - the business rules for placing an order.
 *
 * This is the function the API route calls. Its shape encodes the project's
 * most important security property:
 *
 *   > The server is authoritative. The browser supplies product ids and
 *   > quantities; every rupee, every stock check and every status is decided
 *   > here, from data this process read from the database.
 *
 * The transaction boundary deserves a note, because it is the subtle part.
 * Reserving stock, allocating an order number, inserting the order and its
 * items MUST all commit or all roll back together - otherwise a crash halfway
 * leaves stock reserved for an order that does not exist. So they are one
 * interactive transaction. External calls (Razorpay, WhatsApp) must NEVER be
 * inside it: a third-party timeout would hold the row lock and could roll back
 * a real order. See docs/ADR for the reasoning.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { env, razorpayConfigured } from "@/lib/env";
import { logger, errorFields } from "@/lib/logger";
import { createOrderAccessToken } from "./access-token";
import { priceOrder, type PricedProduct, type PricingProblem } from "./pricing";
import {
  attachRazorpayOrderId,
  decrementStock,
  findProductsForOrder,
  insertOrder,
  nextOrderNumber,
  type TxClient,
} from "./repository";
import { enqueueNotification } from "@/lib/notifications/outbox";
import { buildOrderAlertPayload } from "@/lib/notifications/payload";
import { createRazorpayOrder } from "@/lib/payments/razorpay/client";
import type { RazorpayConfig } from "@/lib/payments/razorpay/types";
import { formatOrderNumber } from "./order-number";
import type { CreateOrderInput } from "@/lib/validation/order";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Thrown to abort the order transaction with a typed, client-safe problem.
 *
 * Using a sentinel rather than returning a result value means the transaction
 * body can `throw` at any point and the rollback is guaranteed - which matters
 * because the stock reservations made before the failure must be undone.
 */
class OrderProblemError extends Error {
  constructor(readonly problem: OrderProblem) {
    super(`order problem: ${problem.kind}`);
    this.name = "OrderProblemError";
  }
}

/** Razorpay credentials, read once. Absent values are rejected by env(). */
function razorpayConfig(): RazorpayConfig {
  const config = env();
  return {
    keyId: config.RAZORPAY_KEY_ID ?? "",
    keySecret: config.RAZORPAY_KEY_SECRET ?? "",
    webhookSecret: config.RAZORPAY_WEBHOOK_SECRET ?? "",
  };
}

/**
 * Queue the owner's "new order" alert.
 *
 * Extracted because two callers need it at different moments: order creation
 * for COD, and payment capture for Razorpay. The unique `(order_id, type)`
 * constraint makes a second call a no-op rather than a second message.
 */
export async function enqueueOrderAlert(
  tx: TxClient,
  order: {
    orderId: string;
    orderNumber: string;
    customerName: string;
    customerPhone: string;
    total: number;
    paymentStatus: "PENDING" | "PAID" | "COD" | "FAILED" | "REFUNDED";
  },
): Promise<void> {
  const pricing = env();
  if (!pricing.ORDER_NOTIFICATION_NUMBER) {
    // Surfaced loudly rather than silently skipping the alert.
    logger.warn("ORDER_NOTIFICATION_NUMBER is not set; no owner alert was queued", {
      orderId: order.orderId,
      orderNumber: order.orderNumber,
    });
    return;
  }

  await enqueueNotification(tx, {
    orderId: order.orderId,
    type: "ORDER_ALERT_BUSINESS",
    recipient: pricing.ORDER_NOTIFICATION_NUMBER,
    payload: buildOrderAlertPayload({
      orderNumber: order.orderNumber,
      customerName: order.customerName,
      total: order.total,
      paymentStatus: order.paymentStatus,
      customerPhone: order.customerPhone,
    }) as unknown as Prisma.InputJsonValue,
  });
}

export type OrderProblem =
  | PricingProblem
  | { kind: "order-number-conflict" }
  | { kind: "razorpay-not-configured" }
  | { kind: "razorpay-unavailable"; detail: string };

export type CreateOrderSuccess = {
  id: string;
  orderNumber: string;
  subtotal: number;
  shipping: number;
  total: number;
  paymentMethod: "COD" | "RAZORPAY";
  paymentStatus: "PENDING" | "COD";
  orderStatus: "NEW";
  /**
   * Signed, expiring token that authorises viewing the confirmation page.
   * Returned to the client exactly once, at creation, and never stored - the
   * signature is the storage.
   */
  accessToken: string;
};

/**
 * What the client needs to open Razorpay Checkout. Absent for COD.
 *
 * `keyId` is the PUBLIC key, safe to hand to the browser. The secret never
 * leaves the server.
 */
export type RazorpayCheckout = {
  razorpayOrderId: string;
  keyId: string;
  amountPaise: number;
  currency: string;
};

export type CreateOrderResult =
  | { ok: true; order: CreateOrderSuccess; razorpay?: RazorpayCheckout }
  /**
   * The order was CREATED but online payment could not be started.
   *
   * `order` is present precisely because the order exists: stock is reserved
   * and the customer must be able to reach it and retry, rather than being told
   * "failed" while an invisible order holds a unit of stock. Callers must not
   * treat a missing `order` as "nothing happened".
   */
  | { ok: false; problem: OrderProblem; order?: CreateOrderSuccess };

/** Postgres unique-violation, as Prisma reports it. */
const UNIQUE_VIOLATION = "P2002";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}

/**
 * Place an order, for either payment method.
 *
 * Order of operations, and why:
 *  1. Load products from the database (never trust the request's contents).
 *  2. Price them with `priceOrder` - a pure function, so the arithmetic is
 *     testable and the browser's numbers are irrelevant.
 *  3. Open one transaction that reserves stock, allocates a number, then
 *     inserts the order and its items.
 *  4. For Razorpay ONLY, call the provider AFTER the transaction commits.
 *
 * Step 4 is the deliberate part. A Razorpay API call inside the transaction
 * would hold row locks for the duration of a network round trip to a third
 * party, and a timeout could not roll back cleanly. So the order is committed
 * first as PENDING, and the provider call happens outside. If it fails, the
 * order still exists - it is a real, reserved, unpaid order that the customer
 * can retry paying, which is a far better outcome than losing the reservation.
 *
 * WHY THE ALERT IS ENQUEUED AT DIFFERENT TIMES PER METHOD:
 *   - COD: at creation. The order is complete and actionable immediately.
 *   - Razorpay: NOT at creation. An abandoned checkout would alert the owner
 *     about an order that was never paid. Instead the webhook enqueues the
 *     alert when the payment is captured. The unique `(order_id, type)`
 *     constraint means it can only ever fire once per order.
 */
export async function createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
  const pricing = env();
  const isCod = input.paymentMethod === "COD";

  // Fail before doing work if online payment is selected but unconfigured.
  if (!isCod && !razorpayConfigured()) {
    return { ok: false, problem: { kind: "razorpay-not-configured" } };
  }

  let created: { order: CreateOrderSuccess; totalPaise: number };
  try {
    created = await prisma.$transaction(async (tx) => {
      const productIds = input.items.map((item) => item.productId);
      const products = (await findProductsForOrder(tx, productIds)) as PricedProduct[];

      const priced = priceOrder(products, input.items, {
        shippingFeePaise: pricing.SHIPPING_FEE_PAISE,
        freeShippingThresholdPaise: pricing.FREE_SHIPPING_THRESHOLD_PAISE,
      });
      if (!priced.ok) {
        throw new OrderProblemError(priced.problem);
      }

      // Reserve stock. The first line that cannot be reserved aborts the
      // transaction, so earlier reservations roll back.
      for (const line of priced.lines) {
        const reserved = await decrementStock(tx, line.product.id, line.quantity);
        if (!reserved) {
          throw new OrderProblemError({
            kind: "insufficient-stock",
            productId: line.product.id,
            name: line.product.name,
            requested: line.quantity,
            available: line.product.stock,
          });
        }
      }

      const sequence = await nextOrderNumber(tx, "order");
      const orderNumber = formatOrderNumber(pricing.ORDER_NUMBER_PREFIX, sequence);

      const order = await insertOrder(
        tx,
        {
          orderNumber,
          customerName: input.customer.name,
          customerPhone: input.customer.phone,
          customerEmail: input.customer.email || null,
          address: input.customer.address,
          city: input.customer.city,
          state: input.customer.state,
          pincode: input.customer.pincode,
          subtotal: priced.subtotalPaise,
          shipping: priced.shippingPaise,
          total: priced.totalPaise,
          paymentMethod: input.paymentMethod,
          // COD is a settled concept; Razorpay starts unpaid, awaiting capture.
          paymentStatus: isCod ? "COD" : "PENDING",
          orderStatus: "NEW",
        },
        priced.lines,
      );

      if (isCod) {
        // Enqueue the owner alert INSIDE this transaction. This is the whole
        // point of the outbox: "the order exists" and "a notification is owed"
        // become one atomic fact. There is no window where an order is
        // committed but its notification was never recorded.
        //
        // The WhatsApp API is NOT called here. It is called later by the
        // worker, so Meta being slow or down cannot fail or delay this request.
        await enqueueOrderAlert(tx, {
          orderId: order.id,
          orderNumber: order.orderNumber,
          customerName: order.customerName,
          customerPhone: order.customerPhone,
          total: order.total,
          paymentStatus: order.paymentStatus,
        });
      }

      logger.info("order created", {
        orderId: order.id,
        orderNumber: order.orderNumber,
        total: order.total,
        paymentMethod: order.paymentMethod,
        itemCount: priced.lines.length,
      });

      // Minted after the insert, because it binds to the order id. Returned to
      // the client and never stored - the signature is the storage.
      const accessToken = createOrderAccessToken(order.id, pricing.ADMIN_SESSION_SECRET);

      return {
        order: {
          id: order.id,
          orderNumber: order.orderNumber,
          subtotal: order.subtotal,
          shipping: order.shipping,
          total: order.total,
          paymentMethod: input.paymentMethod,
          paymentStatus: isCod ? ("COD" as const) : ("PENDING" as const),
          orderStatus: "NEW" as const,
          accessToken,
        },
        totalPaise: order.total,
      };
    });
  } catch (error) {
    if (error instanceof OrderProblemError) {
      return { ok: false, problem: error.problem };
    }
    // A concurrent duplicate would surface as a unique violation on
    // order_number; the caller can retry. Anything else is a real fault.
    if (isUniqueViolation(error)) {
      logger.warn("order number conflict, retryable", errorFields(error));
      return { ok: false, problem: { kind: "order-number-conflict" } };
    }
    logger.error("order creation failed", errorFields(error));
    throw error;
  }

  if (isCod) {
    return { ok: true, order: created.order };
  }

  // --- Razorpay, OUTSIDE the transaction -----------------------------------
  // The order exists and its stock is reserved. Now ask Razorpay to create its
  // order. A failure here leaves a real PENDING order the customer can retry.
  const razorpay = await createRazorpayOrder(razorpayConfig(), {
    amountPaise: created.totalPaise,
    receipt: created.order.orderNumber,
    notes: { localOrderId: created.order.id, orderNumber: created.order.orderNumber },
  });

  if (!razorpay.ok) {
    logger.error("razorpay order creation failed", {
      orderId: created.order.id,
      orderNumber: created.order.orderNumber,
      code: razorpay.error.code,
      description: razorpay.error.description,
    });
    // The local order stays, and it is returned to the client so the customer
    // can reach the confirmation page and retry. Returning a bare failure would
    // leave an invisible order holding reserved stock.
    return {
      ok: false,
      problem: { kind: "razorpay-unavailable", detail: razorpay.error.description },
      order: created.order,
    };
  }

  await attachRazorpayOrderId(created.order.id, razorpay.order.id);

  logger.info("razorpay order created", {
    orderId: created.order.id,
    orderNumber: created.order.orderNumber,
    razorpayOrderId: razorpay.order.id,
  });

  return {
    ok: true,
    order: created.order,
    razorpay: {
      razorpayOrderId: razorpay.order.id,
      keyId: env().RAZORPAY_KEY_ID ?? "",
      amountPaise: razorpay.order.amount,
      currency: razorpay.order.currency,
    },
  };
}

/** HTTP status for a problem, so the route stays dumb. */
export function statusForProblem(problem: OrderProblem): number {
  switch (problem.kind) {
    case "empty":
    case "invalid-quantity":
      return 400;
    case "product-not-found":
      return 404;
    case "product-inactive":
    case "insufficient-stock":
      return 409;
    case "razorpay-not-configured":
    case "razorpay-unavailable":
      // 503: the request is valid, the dependency is not usable. Never 500, so
      // monitoring can tell "our bug" from "a provider is down".
      return 503;
    case "order-number-conflict":
      return 503;
  }
}

/** Human-readable, client-safe message for a problem. No internal detail. */
export function messageForProblem(problem: OrderProblem): string {
  switch (problem.kind) {
    case "empty":
      return "Your cart is empty.";
    case "invalid-quantity":
      return "One of the items has an invalid quantity.";
    case "product-not-found":
      return "One of the items is no longer available.";
    case "product-inactive":
      return `"${problem.name}" is no longer available.`;
    case "insufficient-stock":
      return `Only ${problem.available} of "${problem.name}" left in stock.`;
    case "razorpay-not-configured":
      return "Online payment is not available right now. Please choose cash on delivery.";
    case "razorpay-unavailable":
      // The order WAS created and its stock reserved; only payment could not
      // start. Saying "try again" is honest and the retry works.
      return "We saved your order but could not start the online payment. Please try again, or choose cash on delivery.";
    case "order-number-conflict":
      return "We could not place your order right now. Please try again.";
  }
}

export { type TxClient };
