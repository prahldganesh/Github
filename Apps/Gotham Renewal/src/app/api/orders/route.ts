/**
 * Create an order.
 *
 * Transport only. This handler's whole job is: read the body, validate it,
 * call the service, map the result to a status code. It contains no pricing,
 * no SQL, and no business rules - those live in `lib/orders`, which is why they
 * can be tested without an HTTP server.
 *
 * The request body from the browser carries product ids and quantities ONLY.
 * `createOrderSchema` has no field for a price or a total, so an injected one
 * is stripped before it can reach anything.
 *
 * Next 16 note: route handlers are uncached by default and POST is never
 * cached, so no `dynamic` export is needed.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createOrderSchema, fieldErrors } from "@/lib/validation/order";
import {
  createOrder,
  messageForProblem,
  statusForProblem,
} from "@/lib/orders/service";
import { logger, errorFields } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  // A cheap guard against order spam. Distributed when Upstash is configured;
  // otherwise per-instance. Best-effort either way - see `lib/rate-limit.ts`.
  const limit = await rateLimit(request, { key: "create-order", limit: 10, windowMs: 60_000 });
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests. Please wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsed = createOrderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Some details need fixing.", fields: fieldErrors(parsed.error) },
      { status: 400 },
    );
  }

  // Both payment methods are supported. The schema restricts the value to
  // COD | RAZORPAY, so nothing else can reach the service.
  try {
    const result = await createOrder(parsed.data);

    if (!result.ok) {
      // A 503 from the Razorpay branch still carries the order it created, so
      // the client can offer a retry instead of losing it. The shape matches
      // the success case, which keeps the client's handling uniform.
      return NextResponse.json(
        {
          error: messageForProblem(result.problem),
          code: result.problem.kind,
          order: result.order
            ? {
                id: result.order.id,
                orderNumber: result.order.orderNumber,
                total: result.order.total,
                paymentMethod: result.order.paymentMethod,
                paymentStatus: result.order.paymentStatus,
                orderStatus: result.order.orderStatus,
                accessToken: result.order.accessToken,
              }
            : null,
          razorpay: null,
        },
        { status: statusForProblem(result.problem) },
      );
    }

    // Return only what the confirmation page and Razorpay Checkout need. No
    // customer PII is echoed back. The access token authorises viewing the
    // order, so it is returned here and nowhere else - it is never stored
    // server-side or logged.
    //
    // `razorpay.keyId` is the PUBLIC key: it is designed to be used in the
    // browser. `keySecret` and `webhookSecret` are never sent.
    return NextResponse.json(
      {
        order: {
          id: result.order.id,
          orderNumber: result.order.orderNumber,
          total: result.order.total,
          paymentMethod: result.order.paymentMethod,
          paymentStatus: result.order.paymentStatus,
          orderStatus: result.order.orderStatus,
          accessToken: result.order.accessToken,
        },
        razorpay: result.razorpay ?? null,
      },
      { status: 201 },
    );
  } catch (error) {
    logger.error("unhandled error creating order", errorFields(error));
    return NextResponse.json(
      { error: "Something went wrong placing your order. Please try again." },
      { status: 500 },
    );
  }
}
