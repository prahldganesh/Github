# Razorpay Integration — Research

Scope: server-side Orders API, Checkout, webhook signature verification,
idempotency, retry semantics, test mode, security. Target stack: Next.js App
Router route handlers (Node runtime), TypeScript strict, Prisma/Postgres,
integer paise. Node SDK is the `razorpay` npm package.

All claims below cite the official docs pages fetched while writing this
(razorpay.com/docs) or the SDK source on GitHub.

---

## 1. Server-side setup — the `razorpay` Node SDK

Install:

```bash
npm install razorpay
```

Initialize once, server-side only. The instance holds `key_secret`, so it must
never be imported into a Client Component. In this repo `src/lib/razorpay/`
should import `server-only` (same rule as `lib/db`, see
`docs/ARCHITECTURE.md` §2).

```ts
// src/lib/razorpay/client.ts
import "server-only";
import Razorpay from "razorpay";

if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set");
}

export const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});
```

Env names already reserved in `.env.example`:
`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`.

### Creating an Order

`amount` is the charge **in paise** (smallest sub-unit). ₹500.00 → `50000`.
Required: `amount` and `currency`. Strongly recommended: `receipt` (max 40
chars, must be unique per account; it is effectively an idempotency key — a
second create with the same receipt is rejected) and `notes` (≤15 pairs, each
value ≤256 chars) to carry our `orderNumber`/`orderId` for later correlation.

```ts
// src/lib/razorpay/orders.ts
import "server-only";
import { razorpay } from "./client";

export type CreatedRazorpayOrder = {
  id: string;
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string | null;
  status: "created" | "attempted" | "paid";
  attempts: number;
  notes: Record<string, string> | [];
  created_at: number;
};

export async function createRazorpayOrder(input: {
  amountPaise: number;
  receipt: string; // our orderNumber, <=40 chars, unique
  localOrderId: string;
}): Promise<CreatedRazorpayOrder> {
  const order = await razorpay.orders.create({
    amount: input.amountPaise, // integer paise; MUST be an int
    currency: "INR",
    receipt: input.receipt,
    notes: {
      local_order_id: input.localOrderId,
      order_number: input.receipt,
    },
  });
  return order as unknown as CreatedRazorpayOrder;
}
```

Response fields (from the Orders Entity page):

| Field | Meaning |
|---|---|
| `id` | `order_...`. Store this on our Order as `razorpay_order_id`. Maps 1:1 to one payment attempt. |
| `entity` | `"order"`. |
| `amount` | Amount the order was created for, in paise. |
| `amount_paid` | Amount already paid against the order. |
| `amount_due` | Amount still pending. |
| `currency` | ISO code, e.g. `INR`. |
| `receipt` | Our reference, echoed back. Must be unique per account. |
| `status` | `created` → `attempted` (first payment tried) → `paid` (captured). `paid` is terminal even after refunds. |
| `attempts` | Count of attempts, success and failure. |
| `notes` | Key–value pairs we supplied. |
| `created_at` | Unix seconds. |

Gotchas:
- `amount` must be a JSON integer. `100.0` or `"100"` is rejected.
- Minimum ₹1.00 (`amount >= 100`), else `400 "The amount must be at least INR 1.00"`.
- **One order per payment attempt.** If a payment fails and the customer
  retries, create a *new* Razorpay order and hand the new `order_id` to
  Checkout. Reusing an order id errors.
- Error shape is `{ error: { code, description, source, step, reason, field } }`.

---

## 2. Checkout on the client (and why its success callback is untrusted)

Load the script and open Checkout with the server-created order id. The browser
receives only *public* data:

- `key` — the **key_id** (`rzp_test_...` / `rzp_live_...`). This is the only
  credential the browser may see.
- `order_id` — from step 1.
- `amount`, `currency` — from step 1 for display; Razorpay does not trust the
  client, and neither do we. The authoritative amount is the one stored on the
  Razorpay order / our DB.

```tsx
"use client";

declare global {
  interface Window {
    Razorpay: new (options: Record<string, unknown>) => {
      open: () => void;
      on: (event: string, cb: (resp: unknown) => void) => void;
    };
  }
}

export function PayButton({ orderId, totalPaise }: { orderId: string; totalPaise: number }) {
  async function pay() {
    // Load the script once (or via next/script in the page).
    await new Promise<void>((resolve) => {
      if (window.Razorpay) return resolve();
      const s = document.createElement("script");
      s.src = "https://checkout.razorpay.com/v1/checkout.js";
      s.onload = () => resolve();
      document.body.appendChild(s);
    });

    const rzp = new window.Razorpay({
      key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID, // key_id only, never the secret
      order_id: orderId,
      amount: totalPaise,
      currency: "INR",
      name: "Gotham Renewal",
      handler: function () {
        // UNTRUSTED. Do nothing but tell the UI to show "processing".
        // Do NOT mark the order paid here.
        window.location.href = `/order/processing?order=${orderId}`;
      },
      theme: { color: "#000000" },
    });

    rzp.on("payment.failed", function () {
      // Also untrusted, and not a substitute for the payment.failed webhook.
    });

    rzp.open();
  }

  return <button onClick={pay}>Pay</button>;
}
```

Checkout's success callback returns `razorpay_payment_id`, `razorpay_order_id`,
`razorpay_signature`. You may verify *this* signature for fast UI feedback, but
it is **not** the authoritative paid signal. The signed webhook (§3) is. A
malicious client can synthesize the callback; only the webhook is verified
against our secret and tied to our order record. Docs are explicit:
`callback_url`/handler is UI; webhooks are server truth ("Webhooks vs
callback_url — these are different things").

---

## 3. Webhook signature verification (the important part)

Algorithm, from the docs and the SDK source:

1. Razorpay computes `HMAC-SHA256(key = webhook_secret, message = RAW request body)`
   and sends the hex digest in the **`X-Razorpay-Signature`** header.
2. We recompute the same digest and compare **in constant time**.
3. The signed payload is the **raw, byte-for-byte request body**. It is not a
   re-serialized object. The docs warn: *"Do not parse or cast the webhook
   request body."* (SDK `validateWebhookSignature` does
   `crypto.createHmac('sha256', secret).update(body).digest('hex')`.)

### Why the raw body matters in a Next.js App Router route handler

Next's route handler gives you a `Request` with a stream body. If you call
`await request.json()` first, the body is consumed and parsed; re-serializing
with `JSON.stringify(parsed)` will almost never reproduce the original bytes —
key order, whitespace, unicode escaping, and number formatting all change — so
the HMAC mismatches and you reject a legitimate webhook. Therefore: read the
body **once, as text**, use that exact string for the HMAC, *then* parse the
same string for business logic.

```ts
// src/app/api/webhooks/razorpay/route.ts
import { NextRequest } from "next/server";
import crypto from "node:crypto";
import "server-only";

export const runtime = "nodejs"; // HMAC needs node:crypto; do not use edge

function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  // Constant-time compare; guards length mismatch first.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text(); // RAW body, once
  const signature = request.headers.get("x-razorpay-signature");
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!signature || !secret) {
    return new Response("bad request", { status: 400 });
  }
  if (!verifySignature(rawBody, signature, secret)) {
    return new Response("invalid signature", { status: 400 });
  }

  const event = JSON.parse(rawBody) as RazorpayWebhookEvent;
  // ... idempotency + business logic (§4, §5)
  return Response.json({ ok: true }, { status: 200 });
}
```

You may instead call the SDK helper, but only if the body passed is the raw
string (the SDK docs show `JSON.stringify(webhookBody)` where `webhookBody` is
already the raw string — do not `JSON.parse` it first):

```ts
import { validateWebhookSignature } from "razorpay/dist/utils/razorpay-utils";

const ok = validateWebhookSignature(rawBody, signature, secret);
```

Note: the SDK's own `validateWebhookSignature` uses `===`, a non-constant-time
compare. `crypto.timingSafeEqual` is the safer primitive; the timing risk in
practice is low, but it is free to do right.

If the webhook secret is ever rotated, retried deliveries are signed with the
**old** secret — validating them with the new secret fails. Keep the old secret
available during the retry window.

---

## 4. Which webhook events matter

Payment webhook events (Payments webhook events page):

| Event | When | Notes |
|---|---|---|
| `payment.authorized` | Payment authorised (not yet captured) | Useful for late authorisation. |
| `payment.captured` | Payment successfully captured | Contains only the `payment` entity. |
| `payment.failed` | Payment failed | See retry warning below. |
| `order.paid` | Order status → `paid` | Contains **both** `order` and `payment` entities. |

**Recommended minimal set for this project: `payment.captured` + `payment.failed`.**
`payment.captured` alone is sufficient to mark an order paid; `order.paid` is a
reasonable alternative because it carries both entities in one payload, but do
not subscribe to both as the paid trigger — treating them as independent paid
signals risks double-processing. Pick one paid trigger (`payment.captured`)
and treat `order.paid` as redundant/optional.

Why `payment.captured` over `payment.authorized`: an authorised payment is not
settled, and uncaptured payments are auto-refunded. For a small store with
Dashboard auto-capture on, capture is the correct "money is ours" signal.
(If capture is manual in your account, you would also need to capture via API —
out of scope; use Dashboard auto-capture.)

`payment.failed` is for customer messaging / order state, **not** a paid signal.
Be aware of an expected sequence: `payment.failed` may be followed by
`payment.captured` for the same transaction (UPI retry / late authorisation).
So a failure handler must be able to transition the order back to PAID when the
capture later arrives; never hard-fail an order on `payment.failed` alone.

### Extracting ids

```ts
type RazorpayWebhookEvent = {
  entity: "event";
  account_id: string;
  event: string;                 // e.g. "payment.captured"
  contains: string[];
  payload: {
    payment?: { entity: RazorpayPaymentEntity };
    order?: { entity: RazorpayOrderEntity };
  };
  created_at: number;
};

type RazorpayPaymentEntity = {
  id: string;            // pay_...
  entity: "payment";
  amount: number;        // paise
  currency: string;
  status: "authorized" | "captured" | "failed" | string;
  order_id: string;      // order_... — join key to our Order
  method?: string;
  captured?: boolean;
  error_code?: string | null;
  error_description?: string | null;
  email?: string | null;
  contact?: string | null;
};

type RazorpayOrderEntity = {
  id: string;            // order_...
  entity: "order";
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt?: string | null;
  status: "created" | "attempted" | "paid" | string;
};

// payment.captured / payment.failed:
const payment = event.payload.payment?.entity;
const razorpayOrderId = payment?.order_id;
const razorpayPaymentId = payment?.id;

// order.paid additionally gives:
const orderEntity = event.payload.order?.entity;
```

Join on `payment.order_id` → our `Order.razorpay_order_id` (or on
`order.receipt` → our `order_number`). Prefer the id join; `receipt` is a
human-facing fallback.

---

## 5. Idempotency (webhooks are at-least-once and can be out of order)

Razorpay uses **at-least-once** delivery: a delivery that is not answered 2xx
within 5 seconds is retried, so the same event can arrive many times. Events
can also arrive out of order. Duplicates are expected, not exceptional.

How to dedupe:

- Razorpay provides **`x-razorpay-event-id`**, "unique per event" (docs:
  Validate/Test → Idempotency; Best Practices → Handle Duplicate Events). This
  is the ideal dedupe key when present.
- The **signature is not a unique event id**. It only proves authenticity; a
  retried delivery of the same event will carry the same signature.
- There is no single canonical event id in the body. `payload.payment.entity.id`
  is a payment id, not an event id: the same payment can legitimately appear in
  `payment.authorized`, `payment.captured`, and `payment.failed`. So if you
  derive a key from the body, combine entities with the event type.

Practical strategy, matched to this repo's `payment_event (provider,
provider_event_id)` unique constraint (ARCHITECTURE.md §4): store one row per
processed event, keying:

```ts
function deriveEventId(event: RazorpayWebhookEvent, rawBody: string, headerEventId: string | null): string {
  if (headerEventId) return headerEventId;                       // best when present
  const paymentId = event.payload.payment?.entity.id ?? "none";
  const orderId = event.payload.order?.entity.id ?? "none";
  // fall back to a content hash; include event name so two different event
  // types for the same payment are NOT collapsed into one
  const hash = crypto.createHash("sha256").update(rawBody).digest("hex");
  return `${event.event}:${paymentId}:${orderId}:${hash}`;
}
```

If you key purely on the body hash, a byte-identical retry dedupes correctly
(desirable) but two semantically distinct events always differ (also fine). If
you key on `event + payment_id`, retries dedupe and different event types do
not collide, but you lose the ability to dedupe two logically-identical events
whose bytes differ. The header id, when present, is strictly best.

### Insert-first / catch-unique-violation

The race-safe pattern is to make the **database** the dedupe gate, not a
read-then-write in application code (two concurrent deliveries can both pass a
pre-check). Insert the payment_event row *first* inside the same transaction as
the state change; if the unique constraint fires, the event is a duplicate —
return 200 and do nothing further.

```ts
// inside POST /api/webhooks/razorpay, after signature verification
import { Prisma } from "@/generated/prisma";

const providerEventId = deriveEventId(event, rawBody, request.headers.get("x-razorpay-event-id"));

try {
  await prisma.$transaction(async (tx) => {
    await tx.paymentEvent.create({
      data: {
        provider: "RAZORPAY",
        providerEventId,
        eventType: event.event,
        payload: event as unknown as Prisma.InputJsonValue,
        processedAt: new Date(),
      },
    });
    // only reached on first sight of this event:
    if (event.event === "payment.captured") {
      const payment = event.payload.payment!.entity;
      // find order by razorpay_order_id, verify amount/currency, then mark PAID
    }
    if (event.event === "payment.failed") {
      // record failure; do not destroy a PAID order
    }
  });
} catch (err) {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    return Response.json({ ok: true, duplicate: true }, { status: 200 });
  }
  // Unknown failure: return 5xx so Razorpay retries (§6)
  return new Response("processing error", { status: 500 });
}
```

Because the insert and the order update share one `$transaction`, a crash
between them rolls both back and the retry reprocesses cleanly. Returning 200
on `P2002` tells Razorpay "received"; the duplicate is absorbed.

---

## 6. Response semantics — what makes Razorpay retry

From Best Practices / Setup page:

- Success requires a **2xx** status (the whole `2XX` range) **within 5 seconds**.
- **Any non-2xx, or a timeout beyond 5 s, is a delivery failure** and is
  retried with **exponential backoff for 24 hours** from the event creation
  time.
- If deliveries keep failing for 24 hours, the webhook is **disabled**; you are
  emailed (Alert Email, or the account email) and must re-enable it on the
  Dashboard.

Implications:
- Verify → process → return `200` fast. Do not do slow work (WhatsApp send)
  before responding. Keep the notification outside the webhook request path
  (ARCHITECTURE.md already mandates this: WhatsApp failure must never affect
  payment).
- Return `4xx` only for things Razorpay retrying will not fix (bad signature).
  A bad signature is not a retryable condition and arguably warrants `400`.
- Return `5xx` for transient/unknown internal failures so the event is retried.
- Return `200` on duplicates, even though you did no work.

---

## 7. Test mode vs live mode

- **Key prefixes:** test-mode keys start `rzp_test_`, live-mode keys start
  `rzp_live_` (`.env.example` already documents this). Keys from one mode will
  not authenticate in the other (`400 Authentication failed`).
- **Signing algorithm is identical** in both modes: HMAC-SHA256 over the raw
  body with the configured secret. Payment *payloads* are the same shape in
  Test and Live, so stage testing is trustworthy.
- **Separate webhook secrets:** you configure webhooks independently in Test
  and Live mode on the Dashboard, each with its own secret. A webhook secret
  does **not** have to equal the API key secret. Keep one webhook secret per
  mode in env; do not reuse a live secret for test traffic.
- **Webhook URLs:** public HTTPS, ports 80/443 only. `localhost` is rejected,
  and many tunneling domains are **blacklisted** — the docs explicitly list
  `ngrok.io`, `loca.lt`, `requestbin.com`, `webhook.site`, `hookbin.com`,
  `beeceptor.com`, `mockbin.org`, and internal `.local`/`.internal`/`.corp`
  domains. For local testing the docs point at **`zrok`**; a custom domain
  tunnel (e.g. Cloudflare Tunnel on your own domain) works where
  `*.ngrok.io` is blocked. Otherwise test against a staging deploy configured
  in Test mode.
- **Other test-mode facts:** default OTP `754081` when creating/editing/deleting
  a webhook in Test mode; UPI `success@razorpay` / `failure@razorpay`; test
  cards e.g. Visa `4100 2800 0000 1007`; the mock bank page has Success/Failure
  buttons.
- **Webhook simulator:** Test-mode events fire for Test-mode transactions; use
  a request interceptor or a Test-mode staging endpoint to see payloads.

Config recap for this repo:

```bash
# .env (test)
RAZORPAY_KEY_ID="rzp_test_xxxxxxxx"
RAZORPAY_KEY_SECRET="..."            # NEVER NEXT_PUBLIC_
RAZORPAY_WEBHOOK_SECRET="..."        # Test-mode webhook secret
NEXT_PUBLIC_RAZORPAY_KEY_ID="rzp_test_xxxxxxxx"  # key_id is the ONE public value
```

---

## 8. Security checklist

- **`key_secret` never leaves the server.** Only `key_id` may be public
  (`NEXT_PUBLIC_*`). Anything under `NEXT_PUBLIC_` is inlined into the browser
  bundle and world-readable (`.env.example` says this; it is true).
- **Webhook secret only server-side.** Used for HMAC; leaking it lets anyone
  forge webhooks.
- **Verify the signature against the raw body** before touching the database.
  Reject when the `X-Razorpay-Signature` header or a secret is missing.
- **Never trust the webhook's amount blindly.** After verifying the signature,
  look up *our* Order by `razorpay_order_id`, and compare the payment's
  `amount` and `currency` to the stored `total_paise` / `"INR"` and the
  stored `razorpay_order_id`. Only then mark PAID. This defends against a
  webhook that is authentic but does not correspond to our expected charge
  (e.g. a stale or mismatched order id, or a bug upstream).
- **Unknown order:** if the webhook references an `order_id` that is not in our
  DB, do **not** create an order from it. Record the event (idempotency row),
  log at warn/error level, and return `200` (nothing to retry; retrying will
  not make the order appear). Alert separately.
- **Do not treat the browser redirect or handler as proof of payment.**
- **Idempotency gate is the database unique constraint**, not an app-level
  pre-check.
- **Whitelist Razorpay webhook IPs** as defence-in-depth (docs list egress IPs
  incl. CIDRs `18.96.225.0/26`, `18.99.161.0/26`), but **signature
  verification is still required** even with IP whitelisting — docs say so.
- **HTTPS/TLS 1.2+** only; TLS 1.0/1.1 are not supported by Razorpay production.
- **Do not pin Razorpay SSL certificates** (docs explicitly discourage it and
  stopped publishing new cert files as of Sept 2026).
- **Paise integer arithmetic** everywhere; no floats on money.
- **Use `crypto.timingSafeEqual`** for the signature compare.
- Return only a minimal response body; do not echo the payload back.

---

## 9. Five most common integration mistakes

1. **Trusting the client callback / redirect as "paid".** Anyone can POST to
   your verify endpoint or fake the handler response. Only the signed webhook
   (or a server-side payment fetch) proves payment.
2. **Parsing then re-serializing the webhook body before HMAC.** Key order /
   whitespace changes break the digest and produce false signature failures
   (or, worse, a developer "fixes" it by skipping verification). Read
   `await request.text()` and sign exactly those bytes.
3. **No idempotency.** Retries and out-of-order events cause the same order to
   be marked paid, stock decremented, or the business alerted twice. Use the
   `(provider, provider_event_id)` unique insert-first pattern and return 200
   on duplicates.
4. **Not validating amount/currency/order against your own record.** An
   authentic webhook for a different order (or a lower amount) can mark the
   wrong order paid. Re-read the order by `razorpay_order_id` and compare.
5. **Coupled side effects inside the payment transaction.** Sending WhatsApp
   (or any network call) before responding, or inside the order transaction,
   means a slow/failed notification can cause Razorpay retries, timeouts, or a
   rolled-back paid order. Respond 200 first, notify after commit, best-effort.

(Bonus, common: exposing `key_secret` via a `NEXT_PUBLIC_` var; reusing a
Razorpay order id across attempts; treating `payment.failed` as terminal when a
`payment.captured` may follow.)

---

## Recommendations for this project

1. **Two endpoints, clearly separated.** `POST /api/checkout/razorpay` creates
   the Razorpay order server-side from the *DB-computed* total (never a
   client-sent amount) and stores `razorpay_order_id` on the Order.
   `POST /api/webhooks/razorpay` is the only thing that can mark PAID.
2. **Runtime: `export const runtime = "nodejs"`** on the webhook route;
   `node:crypto` is required, and the Node runtime is the architecture's
   stated choice.
3. **Signature:** `crypto.createHmac("sha256", RAZORPAY_WEBHOOK_SECRET)`
   over `await request.text()`, compared with `crypto.timingSafeEqual`. Reject
   with `400` when the header/secret is missing or the compare fails.
4. **Subscribe to `payment.captured` and `payment.failed` only.** Use
   `payment.captured` as the single paid trigger. Do not also treat
   `order.paid` as a paid trigger.
5. **Idempotency:** prefer `x-razorpay-event-id`; fall back to
   `event.event + payment.entity.id + order_id` or a body SHA-256. Insert
   `payment_event` with `provider: "RAZORPAY"` and that `provider_event_id`
   *inside* the same `$transaction` that flips the order to PAID. Catch Prisma
   `P2002`, return `200 { duplicate: true }`.
6. **Validate before flipping:** load the Order by `razorpay_order_id`, confirm
   `payment.amount === order.total_paise` and `currency === "INR"`; otherwise
   record the event and escalate, never mark PAID.
7. **Unknown order:** persist the event, log/alert, return `200`. Do not create
   orders from webhooks.
8. **Response codes:** `200` on success and duplicate; `400` on bad signature;
   `500` on unexpected internal errors so Razorpay retries (24 h backoff).
9. **Notifications after commit:** write the `notification` row and send
   WhatsApp *after* the payment transaction commits, best-effort, exactly as
   ARCHITECTURE.md §4 already specifies. Webhook handler responds before any
   WhatsApp call.
10. **Failed payments are not terminal:** if `payment.failed` arrives, mark
    PAYMENT FAILED only if not already PAID; allow a later `payment.captured`
    to win. This matches the documented failed-then-captured UPI sequence.
11. **Test mode env discipline:** keep separate Test and Live key sets and
    separate `RAZORPAY_WEBHOOK_SECRET` values; never commit them. Expose only
    `key_id` as `NEXT_PUBLIC_RAZORPAY_KEY_ID` for Checkout.
12. **Local testing:** use a custom-domain tunnel (Cloudflare Tunnel) or `zrok`;
    `ngrok.io` and friends are blacklisted by Razorpay.

---

## Sources

- Razorpay, *Create an Order* — https://razorpay.com/docs/api/orders/create/
- Razorpay, *Orders Entity* — https://razorpay.com/docs/api/orders/entity/
- Razorpay, *Node.js Integration Steps* — https://razorpay.com/docs/payments/server-integration/nodejs/payment-gateway/build-integration/ (order creation, Checkout options, `handler`/`callback_url`, payment signature `order_id|payment_id`)
- Razorpay, *About Webhooks* — https://razorpay.com/docs/webhooks/
- Razorpay, *Payments Webhook Events* — https://razorpay.com/docs/webhooks/payments/ (sample payloads, `payment.failed`→`payment.captured` sequence)
- Razorpay, *Validate and Test Webhooks* — https://razorpay.com/docs/webhooks/validate-test/ (`X-Razorpay-Signature`, raw body warning, HMAC-SHA256, `x-razorpay-event-id` idempotency, blacklisted tunnel domains, Test OTP)
- Razorpay, *Webhook Best Practices* — https://razorpay.com/docs/webhooks/best-practices/ (at-least-once, 2xx within 5 s, exponential backoff for 24 h, then disabled)
- Razorpay, *Set Up and Edit Payments Webhooks* — https://razorpay.com/docs/webhooks/setup-edit-payments/ (secret, Alert Email, 2XX/5 s, disable behaviour)
- Razorpay, *IPs and Certificates* — https://razorpay.com/docs/security/whitelists/ (webhook egress IPs/CIDRs, TLS 1.2+, cert-pinning discouraged)
- `razorpay-node` SDK, `lib/utils/razorpay-utils.js` — https://github.com/razorpay/razorpay-node/blob/master/lib/utils/razorpay-utils.js (`validateWebhookSignature`, `validatePaymentVerification`, exact HMAC construction)
- Context7, `/razorpay/razorpay-node` — order create + webhook validation snippets
- Repo: `docs/ARCHITECTURE.md` §4–5, `.env.example` (env names, paise, notification-outside-transaction rule)
