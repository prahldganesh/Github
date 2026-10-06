# WhatsApp Cloud API — research for order notifications

Research for sending an order alert from the Gotham Renewal Next.js server to the
family business's own WhatsApp number, using the **official Meta WhatsApp Business
Platform (Cloud API)**. No SDK is required: the API is plain HTTPS + JSON, so the
whole integration can be a thin `fetch` wrapper.

Sources are cited inline as links. Meta's docs were re-fetched in September 2026;
where a fact is recent or changed, it is called out under **Recent / changed**.

> Summary of the one surprising answer: **the Cloud API has no concept of "your own
> number".** The owner's phone is just another recipient, so the same 24-hour
> customer service window rules apply, which in practice means the first order alert
> **must be a template**, not free-form text. See §2.

---

## 1. The endpoint, auth, and request bodies

### Endpoint

```
POST https://graph.facebook.com/{META_GRAPH_VERSION}/{WHATSAPP_PHONE_NUMBER_ID}/messages
Authorization: Bearer {WHATSAPP_ACCESS_TOKEN}
Content-Type: application/json
```

- `WHATSAPP_PHONE_NUMBER_ID` is the **business phone number ID** (a numeric ID like
  `106540352242922`), *not* the display phone number and not the WABA ID.
- `META_GRAPH_VERSION` is e.g. `v21.0` / `v23.0` / `v26.0`.
- Auth is a bearer token; tokens are opaque strings — do not parse or decode them
  ([Access Tokens](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens)).
- The endpoint is documented under the Messages API
  ([Messages API reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api)).

The common request body shape is:

```jsonc
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",   // or "group"
  "to": "<WHATSAPP_USER_PHONE_NUMBER>",
  "type": "<MESSAGE_TYPE>",          // "text", "template", ...
  "<MESSAGE_TYPE>": { /* contents */ }
}
```

### Text message body

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+16505551234",
  "type": "text",
  "text": {
    "preview_url": true,
    "body": "As requested, here is the link to our latest product: https://www.meta.com/quest/quest-3/"
  }
}
```

([Service messages / send messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages))

### Template message body

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+16505551234",
  "type": "template",
  "template": {
    "name": "order_confirmation",
    "language": { "code": "en_US" },
    "components": [
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "Jessica" },
          { "type": "text", "text": "SKBUP2-4CPIG9" }
        ]
      }
    ]
  }
}
```

([Template fundamentals](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview))

### Successful response

```json
{
  "messaging_product": "whatsapp",
  "contacts": [
    { "input": "+16505551234", "wa_id": "16505551234" }
  ],
  "messages": [
    { "id": "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBI4MjZGRDA0OUE2OTQ3RkEyMzcA" }
  ]
}
```

Meta is careful to say this only means **accepted**, not delivered — delivery is
reported by `messages` webhooks ([Service messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages)).

### TypeScript (plain fetch)

```ts
// lib/whatsapp/client.ts (sketch — see §10 for full layering)
type WhatsappEnv = {
  graphVersion: string;      // META_GRAPH_VERSION
  phoneNumberId: string;     // WHATSAPP_PHONE_NUMBER_ID
  accessToken: string;       // WHATSAPP_ACCESS_TOKEN
};

type SentMessage = { messages: Array<{ id: string }>; contacts?: Array<{ wa_id: string }> };

export async function postMessage(
  env: WhatsappEnv,
  body: unknown,
): Promise<SentMessage> {
  const res = await fetch(
    `https://graph.facebook.com/${env.graphVersion}/${env.phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      // Do not retry here; the service layer decides. See §6.
      signal: AbortSignal.timeout(10_000),
    },
  );

  const json = (await res.json()) as unknown;
  if (!res.ok) throw toGraphError(res.status, json); // §6
  return json as SentMessage;
}
```

---

## 2. The 24-hour customer service window (the important part)

Meta's rule, verbatim: *"When a WhatsApp user messages you … a 24-hour timer called
a customer service window starts. … While the window is open, you can send any of
the following service message types to the user. **When the window closes, you can
only send pre-approved template messages.**"*
([Service messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages))

Key points:

- The window opens when **the recipient messages the business**, and resets on each
  new inbound message or call.
- Free-form ("service") messages — `type: "text"`, image, document, interactive —
  are only allowed **inside** an open window.
- Outside the window, only an **approved template** can be sent. Attempting a
  free-form message fails with error `131047`: *"More than 24 hours have passed
  since the recipient last replied to the sender number."* →
  `error_data.details` says to send a template instead
  ([Error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)).

### Own business number vs a customer — the answer

**There is no API-level notion of "my own number".** The endpoint sends *from* the
business number *to* a WhatsApp user; the owner's phone is a recipient exactly like
a customer. Consequences:

| Scenario | Recipient | Window state | Allowed? |
|---|---|---|---|
| Owner has messaged the business number in the last 24h | Owner | Open | Free-form text **or** template |
| Owner has never messaged (or >24h ago) | Owner | Closed | **Template only** |
| Customer after checkout, no inbound message | Customer | Closed | **Template only** |
| Customer replied, then we reply | Customer | Open | Free-form text **or** template |

So for the "new order alert to the owner" use case:

- Do **not** rely on free-form text. You cannot assume the owner messaged the
  business bot in the last 24 hours (the alert is usually the *first* message of the
  day, and it is business-initiated).
- **Use an approved UTILITY template** for the alert. It is the only thing that
  works reliably outside a window.
- Optional optimisation: once the owner replies to an alert, the window opens and
  you may send free-form follow-ups (e.g. a plain "Order #GR-1043 packed" text)
  without using templates. But because the window is only 24h and depends on the
  owner's behaviour, the **initiating** message must always be a template.

This same rule governs the later customer-facing updates (order confirmed / packed /
shipped / delivered): each is business-initiated unless the customer happens to have
messaged you, so each is a template.

**Recent / changed:** as of **Oct 1, 2026** Meta begins charging for service
(non-template) messages after a free tier of 1,000/month per business number, and for
utility templates sent *within* the window (previously free). Utility templates sent
inside the window were free from Jul 1, 2025
([Pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing),
[Non-template messages pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages)).
For a family business's volumes this is negligible, but it means the old "reply with
free text to avoid charges" trick is less of a saving going forward.

---

## 3. Templates

### Where and how they are created

Templates are **WhatsApp Business Account (WABA) assets** created in
**WhatsApp Manager → Message templates** in Meta Business Suite, or via
`POST /{WABA_ID}/message_templates`
([Template fundamentals](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview)).

Create request shape:

```jsonc
{
  "name": "<TEMPLATE_NAME>",          // lowercase, alphanumeric + underscores, ≤512 chars
  "language": "<TEMPLATE_LANGUAGE>",  // e.g. "en_US", "en"
  "category": "utility",              // see below
  "parameter_format": "named",        // or "positional" (default)
  "components": [ /* header?, body, footer?, buttons? */ ]
}
```

### Categories

| Category | Purpose | Notes |
|---|---|---|
| `MARKETING` | Promotions, awareness, retargeting, re-engagement | Charged; most restricted by per-user limits |
| `UTILITY` | Follow up on a **user action/request**: order confirmation, order status, account alerts | Non-promotional, must be specific to the user's order/account/transaction |
| `AUTHENTICATION` | OTP / identity verification | Must use Template Library authentication templates |

Source: [Template categorization](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization).
Order management examples are explicitly listed under **Utility → Order Management**:
*"Thank you! Your order {{order_number}} is confirmed…"*.

**Gotcha:** utility templates must be **non-promotional**. If you add anything that
promotes, upsells, or cross-sells, Meta re-categorises the template as MARKETING
(and charges marketing rates, and it may be paused). Keep alert bodies purely
transactional.

### Components structure

Templates have up to four primary components; only **body** is required
([Template components](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/components)):

- `header` — optional: text / image / video / document / location
- `body` — required, text only, ≤1024 chars
- `footer` — optional, text, ≤60 chars
- `buttons` — optional, up to 10: URL, phone number, quick reply, copy code, etc.

### Variables / placeholders

Two formats ([Template fundamentals](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview)):

- **Positional:** `{{1}}`, `{{2}}` … Parameters must be sent in order.
- **Named:** `{{first_name}}`, `{{order_number}}` … Lowercase + underscores, unique.
  Send with `parameter_name`. Choose with `parameter_format` at creation.

Named is safer for a template with several fields: reordering the body cannot silently
misalign your payload.

### Approval

Templates are auto-reviewed on create/edit. Status starts `PENDING`; on approval it
becomes `APPROVED` and can be sent. Meta says review **can take up to 24 hours**.
Status changes arrive via the `message_template_status_update` webhook; you can also
poll `GET /{TEMPLATE_ID}?fields=status`
([Template fundamentals](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview),
[Template review](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-review)).

Common rejections: duplicate wording, unclear/placeholder-only content, promotional
content in a utility template, leading/trailing parameters
([Template review](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-review)).

### Recommended "new order" alert (UTILITY)

Template name: `new_order_alert`, language `en_IN` (or `en`), category `utility`,
parameter format `named`.

Body (the exact wording is what Meta reviews; keep it order-specific and
non-promotional):

```
New order {{order_number}}
Customer: {{customer_name}}
Amount: {{amount}}
Payment: {{payment_status}}
View order: {{order_url}}
```

Create payload:

```json
{
  "name": "new_order_alert",
  "language": "en_IN",
  "category": "utility",
  "parameter_format": "named",
  "components": [
    {
      "type": "body",
      "text": "New order {{order_number}}\nCustomer: {{customer_name}}\nAmount: {{amount}}\nPayment: {{payment_status}}\nView order: {{order_url}}",
      "example": {
        "body_text_named_params": [
          { "param_name": "order_number", "example": "GR-1042" },
          { "param_name": "customer_name", "example": "Raj Kumar" },
          { "param_name": "amount", "example": "Rs.2,480" },
          { "param_name": "payment_status", "example": "PAID" },
          { "param_name": "order_url", "example": "https://example.com/admin/orders/123" }
        ]
      }
    }
  ]
}
```

Corresponding send payload:

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "919876543210",
  "type": "template",
  "template": {
    "name": "new_order_alert",
    "language": { "code": "en_IN" },
    "components": [
      {
        "type": "body",
        "parameters": [
          { "type": "text", "parameter_name": "order_number", "text": "GR-1042" },
          { "type": "text", "parameter_name": "customer_name", "text": "Raj Kumar" },
          { "type": "text", "parameter_name": "amount", "text": "Rs.2,480" },
          { "type": "text", "parameter_name": "payment_status", "text": "PAID" },
          { "type": "text", "parameter_name": "order_url", "text": "https://example.com/admin/orders/123" }
        ]
      }
    ]
  }
}
```

Optional footer: `Gotham Renewal`. Optional URL button (`View order`) can replace the
inline link, but a URL button opens the browser and is another review surface — the
inline `order_url` parameter is simpler.

### Recommended "order status update" (UTILITY)

Template name: `order_status_update`, category `utility`, named params:

```
Update on order {{order_number}}
Status: {{status}}
{{note}}
```

Send with `status` ∈ {CONFIRMED, PACKED, SHIPPED, DELIVERED} and `note` = e.g.
tracking info. One template covers all four customer updates; keep it non-promotional
([Template categorization](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization)).

**Gotcha (be honest about this one):** Meta's utility guidelines are written around
messaging *the user who triggered the action*. The owner-alert template's recipient is
your own staff, not the person who placed the order. The content is non-promotional and
transaction-specific, so `utility` is the correct classification on content, but
automated review could re-classify or question it. If approval is refused, fall back to
a generic wording ("New order received" + order fields) and appeal via WhatsApp Manager;
you cannot switch to free-form to dodge this. Keep the body clean and it should pass.

---

## 4. Authentication & tokens

### Temporary vs System User token

| | Temporary User token | System User token (recommended) |
|---|---|---|
| Where | App Dashboard → WhatsApp → API Setup (a fresh token each visit) | Business Settings → System Users → Generate token |
| Lifetime | **~24 hours** | Long-lived / non-expiring ("never" expiration option) |
| Suitable for | First test message, Graph API Explorer | Server-to-server automation |
| Permissions | Scoped to your user | `business_management`, `whatsapp_business_messaging`, `whatsapp_business_management` |

Sources: [Access Tokens guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens),
[Get Started](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started).

Steps for a System User token (from Get Started and Access Tokens):
1. Business Settings → **System users** → Add.
2. Assign assets: your **App** (Manage app / Full control) and your **WhatsApp
   account** (Manage WhatsApp Business accounts / Full control).
3. Generate token, selecting the app and a non-expiring preference, with the three
   permissions above.
4. Store in `WHATSAPP_ACCESS_TOKEN`. Treat as a password.

> Tokens are opaque; use a variable-length string without a max length
> ([Access Tokens guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens)).

### Test number vs real verified business number

- Completing Get Started auto-generates a **test business phone number**, already
  registered. It can only message a limited allow-list of recipient numbers (community
  reports and the error `"Recipient phone number not in allowed list"`; the allowed
  list is **up to 5** numbers added under API Setup → *To*). See
  [Phone numbers](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers)
  and the community threads surfaced via search.
- A **real business number** must be added to the WABA, **verified** (SMS/voice code),
  given an approved **display name**, and **registered** for Cloud API use
  (`register` endpoint). See [Phone numbers](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers).
- Numbers already used in WhatsApp Messenger must be deleted first; a number used with
  the WhatsApp Business *app* can be migrated via Embedded Signup (not our case).

---

## 5. Required setup — DEV/TEST vs PRODUCTION

### DEV / TEST

1. Facebook account + developer registration.
2. Create a Meta app with the **WhatsApp** use case; select/create a Business portfolio
   (this also creates a WABA).
3. API Setup → connect app to WABA → note the **WABA ID** and **Phone number ID**.
4. Generate a **temporary token** and send the `hello_world` template to your own phone.
5. Add up to 5 test recipients to the allowed list.
6. Use the **test number** as `WHATSAPP_PHONE_NUMBER_ID`; `ORDER_NOTIFICATION_NUMBER`
   = the owner's phone, which must be on the allow-list.

### PRODUCTION

1. Same Meta app, move to Live mode.
2. Add a **real business phone number**; verify via SMS/voice; get an **approved display
   name**; register it for Cloud API.
3. Create a **System User** with the three permissions; generate a non-expiring token.
4. Create and get the `new_order_alert` / `order_status_update` templates **APPROVED**.
5. Set up a payment method in Billing Hub (required to send beyond free tiers).
6. Complete **business verification** to unlock higher messaging limits (2,000 → auto
   scaling) and the 20-number cap.
7. Update env vars to the production phone number ID / WABA ID / token.

| Item | DEV / TEST | PRODUCTION |
|---|---|---|
| Phone number | Auto-generated test number | Real number, verified + registered |
| Display name | Test default | Submitted, approved |
| Token | Temporary (~24h, API Setup) | System User token, non-expiring |
| Recipients | Allow-list, **≤5 numbers** | Any opted-in WhatsApp user |
| Templates | `hello_world` + your drafts | Approved UTILITY templates |
| Billing | Not required | Payment method in Billing Hub |
| Business verification | Not required | Required for scaling limits & 20-number cap |
| Messaging limit | Minimal (test) | 250 → 2,000 → 10,000 → 100,000 → Unlimited |
| Throughput | 80 mps default | 80 mps → auto-upgrade to 1,000 mps |

Sources: [Get Started](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started),
[Phone numbers](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers),
[Messaging Limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits),
[Throughput](https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput),
[Pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing).

---

## 6. Error handling

### Envelope

```json
{
  "error": {
    "message": "(#130429) Rate limit hit",
    "type": "OAuthException",
    "code": 130429,
    "error_data": {
      "messaging_product": "whatsapp",
      "details": "Cloud API message throughput has been reached."
    },
    "error_subcode": 2494055,
    "fbtrace_id": "Az8or2yhqkZfEZ-_4Qn_Bam"
  }
}
```

Fields: `error.message`, `error.type`, `error.code`, `error.error_subcode`,
`error.error_data.details`, `error.fbtrace_id`
([WhatsApp error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)).

**Recent / changed:** `error_subcode` is **deprecated and is not returned in v16.0+**.
Meta explicitly says to build handling around **`code` + `details`**, and not to depend
on code *titles* (they appear only inside `message` and will be deprecated). Prefer
`error_data.details` for the human-readable reason.

### Common codes and what to do

| Code | Meaning | Retry? | Action |
|---|---|---|---|
| `190`, `0`, `200` | Token expired / invalid / missing | No (until fixed) | Refresh token; alert ops; mark FAILED |
| `3`, `10`, `131005`, `200-299` | Permission/capability missing | No | Fix permissions; mark FAILED |
| `100`, `131008`, `131009`, `131021` | Invalid/missing param, sender=recipient | No | Bug — fix payload; mark FAILED |
| `130429` | Throughput reached | **Yes**, backoff | Retry later |
| `131048`, `131057` | Rate/quality/maintenance | Yes / later | Backoff; check status |
| `80007` | WABA rate limit | Yes | Backoff |
| `131047` | >24h since recipient replied | No (free-form) | Use an approved template instead |
| `131026` | Undeliverable — not a WhatsApp number, TOS/version | No | Mark FAILED; verify number |
| `132000` | Wrong number of template params | No | Fix mapping bug; mark FAILED |
| `132001` | Template not found / not approved / wrong language | No | Fix template name/language/status; mark FAILED |
| `132012` | Param format mismatch (named vs positional) | No | Fix payload format |
| `132015`, `132016` | Template paused/disabled (quality) | No | Edit/replace template |
| `131042` | Payment/billing issue | No | Fix billing |
| `1`, `2`, `131000`, `131016`, `133004` | Temporary/server | **Yes**, backoff | Retry |
| `368`, `131031` | WABA restricted / policy | No | Resolve policy; mark FAILED |

Transient (`1`, `2`, `130429`, `131016`, `133004`, `80007`) → retry with exponential
backoff. Everything else → mark `FAILED` and surface it (retrying makes it worse or is
pointless). Mapping to notification state:

- Request accepted (HTTP 2xx, `messages[0].id` present) → **SENT**
- Non-retryable Graph error → **FAILED** (store `code`, `details`, `fbtrace_id`)
- Retryable error → keep **PENDING**, increment attempt count, schedule retry
- Network/timeout with no response → keep **PENDING**, retry (the request may or may
  not have been received — see §7)

```ts
type GraphError = {
  httpStatus: number;
  code?: number | string;
  details?: string;
  message: string;
  fbtraceId?: string;
  retryable: boolean;
};

const RETRYABLE_CODES = new Set<number | string>([
  1, 2, 130429, 131016, 133004, 80007,
]);

export function toGraphError(httpStatus: number, raw: unknown): GraphError {
  const e = (raw as { error?: Record<string, any> })?.error ?? {};
  const code = e.code as number | string | undefined;
  // Network/timeout errors are handled by the caller (no HTTP status there).
  return {
    httpStatus,
    code,
    details: e.error_data?.details,
    message: e.message ?? "Unknown WhatsApp API error",
    fbtraceId: e.fbtrace_id,
    retryable: code !== undefined && RETRYABLE_CODES.has(code),
  };
}
```

---

## 7. Idempotency, dedup, traceability

- **Yes, the API returns a message id:** `messages[0].id`, a `wamid...` string
  ([Service messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages)).
  Store it on the notification row (`provider_message_id`) for traceability and to
  correlate with delivery-status webhooks later.
- **The API has no idempotency key.** Each POST that is accepted creates a new
  message. There is no `Idempotency-Key` header and no server-side dedup based on your
  order id. Therefore **a retry can double-send.** (Contrast with Razorpay's webhook,
  where the provider event id is the idempotency gate — here there is none.)
- Consequence for this app: dedupe in our own code.
  - One `notification` row per order per notification kind (e.g. unique on
    `(order_id, kind)`), created before the send.
  - Only send when the row is `PENDING` and `attempt_count` under a cap.
  - After a **success** store the `wamid` and flip to `SENT`; never resend a `SENT`
    row.
  - A timeout leaves the outcome unknown: the message *may* have been accepted. A
    blind retry can duplicate. Prefer a short retry budget, and accept the small
    duplicate risk (a duplicate order alert is harmless; a duplicate to a *customer*
    is more visible — for customer updates consider only retrying when the API
    returned a definite retryable error, not on ambiguous timeouts).
- Note also: **delivery order is not guaranteed** across a series of messages; if
  sequence matters, wait for a `delivered` status webhook before sending the next
  ([Service messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages)).

---

## 8. Rate limits & throughput (small business)

- **Throughput (send speed):** 80 messages/second per registered number by default,
  auto-upgradable to 1,000 mps; exceeding it returns `130429`
  ([Throughput](https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput)).
  Irrelevant at family-business volume — you will never approach 80 mps.
- **Messaging limits (reach):** the number of **unique** users you may message outside
  a customer service window in a rolling 24h. Portfolio-level: newly created portfolios
  start at **250**, then 2,000 → 10,000 → 100,000 → Unlimited via scaling paths and
  automatic scaling ([Messaging Limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits)).
  For this app, 250/day is plenty; completing **business verification** raises it to
  2,000 regardless of volume.
- **Per-user pair limit:** too many messages to the *same* number quickly returns
  `131056` — avoid spamming the owner with every status change.
- **Template quality/pacing:** new templates (and utility templates after any utility
  pause) can be *paced*; accepted responses may include
  `message_status: "held_for_quality_assessment"`. A paced message is accepted but held
  ([Template pacing](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-pacing)).
  This is another reason not to assume "API accepted" == "delivered".

---

## 9. Security checklist

- **Server-only.** `lib/whatsapp/*` must import `server-only` so a Client Component
  cannot import it (the app already does this for `lib/db`, `lib/env`). Never put the
  token in `NEXT_PUBLIC_*`.
- **Never log the token.** Log `fbtrace_id`, `code`, and `details` — never the
  `Authorization` header or `WHATSAPP_ACCESS_TOKEN`.
- **Rotate tokens.** Even a non-expiring System User token should be rotated on
  personnel change / suspected leak. Keep it in the deployment secret store, not in
  the repo. `.env` is already gitignored.
- **Validate env at boot** (zod) so a missing ID fails fast rather than at the first
  order.
- **Least privilege** on the System User: only the three required permissions.
- **Verify inbound webhooks** (needed later for status/inbound messages):
  1. **GET handshake:** Meta sends `hub.mode=subscribe`, `hub.challenge`,
     `hub.verify_token`. Compare `hub.verify_token` to your configured secret and
     respond with the raw `hub.challenge` value
     ([Webhooks getting started](https://developers.facebook.com/docs/graph-api/webhooks/getting-started)).
  2. **POST signature:** verify `X-Hub-Signature-256` by computing
     `sha256=` + HMAC-SHA256 of the **raw request body** using the **App Secret**, and
     constant-time comparing
     ([Webhooks getting started](https://developers.facebook.com/docs/graph-api/webhooks/getting-started)).
     In Next.js App Router, read the raw bytes (`await req.arrayBuffer()`) before
     parsing JSON, or the signature will not match.
  3. Optionally enable **mTLS** (`client.webhooks.fbclientcerts.com`,
     `meta-outbound-api-ca-2025-12.pem`) for stronger verification
     ([WhatsApp webhooks](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview)).
- **Respond 200 quickly** to webhooks and process asynchronously; Meta retries for up
  to ~36h–7d and batches, so **dedupe** webhook deliveries too.

Webhook signature verification sketch:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | null,
  appSecret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(received, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

---

## 10. Reusable service design sketch

Layering follows the project's architecture rule (`lib/<provider>/` owns the external
provider; services own business rules):

```
lib/whatsapp/
  client.ts        # HTTP + auth + error normalisation ONLY
  templates.ts     # template names, languages, and param mapping ONLY
  types.ts         # request/response/error types (optional)
lib/notifications/
  service.ts       # sendOrderWhatsAppAlert(), sendOrderStatusWhatsAppAlert()
  repository.ts    # notification rows (PENDING|SENT|FAILED) via Prisma
```

Responsibilities:

- **`client.ts`** — owns the endpoint, `Authorization` header, timeouts, and turning
  a Graph error into one `GraphError` type. It knows nothing about orders or templates.
  It must **not** retry (the service decides, because retrying a template send can
  double-send).
- **`templates.ts`** — owns the template *names*, *language codes*, and the mapping
  from a domain object to `components[].parameters`. If a template's wording changes,
  only this file and the Meta template change. It produces a payload, it does not send.
- **`notifications/service.ts`** — owns the business act: create/read the notification
  row, decide whether to send, call the client, interpret `GraphError.retryable`,
  persist `provider_message_id` / state, and surface failures. This is the only layer
  that knows `PENDING|SENT|FAILED`.
- **Callers** (order service, Razorpay webhook handler) call
  `sendOrderWhatsAppAlert(order)` **after** their transaction commits, best-effort. A
  throw here must never roll back a paid order — the ARCHITECTURE doc already commits
  to this.

Signatures (shape only, not implementation):

```ts
// lib/whatsapp/client.ts
export type SendResult = { providerMessageId: string; acceptedAt: Date };
export type GraphError = { /* §6 */ };
export function sendTemplate(to: string, payload: TemplatePayload): Promise<SendResult>;
export function sendText(to: string, body: string): Promise<SendResult>;

// lib/whatsapp/templates.ts
export function newOrderAlertParams(input: NewOrderAlertInput): TemplatePayload;
export function orderStatusParams(input: OrderStatusInput): TemplatePayload;

// lib/notifications/service.ts
export type OrderAlertInput = {
  orderId: string;
  orderNumber: string;      // "GR-1042"
  customerName: string;
  totalPaise: number;       // format with lib/money.formatPaise
  paymentStatus: "PAID" | "PENDING" | "COD";
  orderUrl: string;         // `${APP_BASE_URL}/admin/orders/${orderId}`
};

export async function sendOrderWhatsAppAlert(input: OrderAlertInput): Promise<void>;
export async function sendOrderStatusWhatsAppAlert(
  input: { orderId: string; orderNumber: string; status: OrderStatus },
): Promise<void>;
```

Why this seam:

- One place (`client.ts`) to change if the API version, auth, or error envelope
  changes.
- One place (`templates.ts`) to change when Meta approves/rejects/reword a template —
  and the same single place for the future customer-facing status templates.
- The service layer is testable without HTTP: swap `client.ts` for a fake and assert
  the `PENDING → SENT|FAILED` transitions, including "retryable error keeps PENDING".
- The outbound call stays outside the order transaction, satisfying "a notification
  failure must never roll back a paid order".

---

## Recommendations for this project

1. **Use an approved UTILITY template for the owner alert** (`new_order_alert`). Do not
   plan on free-form text: the API treats the owner as a normal recipient and the first
   business-initiated message needs a template. Keep the body non-promotional so it
   stays `utility` (marketing wording would re-categorise and raise cost/limits).
2. **Use named parameters** (`parameter_format: "named"`) for both templates; safer
   against body edits than positional `{{1}}`.
3. **`en_IN` / `en`** language and `Rs.{amount}` formatting via the existing
   `formatPaise` helper (no floats on money).
4. **System User token**, non-expiring, three permissions; validate all
   `WHATSAPP_*` env vars at boot with zod; `server-only` in `lib/whatsapp/*`.
5. **Store one notification row per order** (unique `(order_id, kind)`), states
   `PENDING|SENT|FAILED`, plus `attempt_count`, `provider_message_id`, `error_code`,
   `error_details`, `fbtrace_id`, `updated_at`. Dedupe `SENT` rows; retry only
   retryable codes with backoff; never let this throw into the order transaction.
6. **Version:** keep `META_GRAPH_VERSION` in env and pin it to a currently-supported
   version (Meta's own examples use `v26.0` as of Sep 2026; `v21.0` is old). Check the
   version dropdown in the App Dashboard rather than hardcoding.
7. **DEV first:** use the test number + a ≤5-number allow-list containing the owner's
   phone; get templates approved before switching to the production number. Verify the
   production number and complete business verification to raise limits.
8. **Later, for customer updates:** reuse the same `client.ts`; add one
   `order_status_update` utility template; consider a webhook receiver to capture
   delivery status and correlate via `wamid`, verifying `X-Hub-Signature-256` against
   the App Secret over the raw body.

### Sources

- Messages API / send messages: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages
- Message API reference: https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api
- Template fundamentals: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview
- Template components: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/components
- Template categorization: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization
- Utility templates: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/utility-templates/utility-templates
- Template review: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-review
- Error codes: https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
- Access tokens: https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens
- Get started: https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started
- Phone numbers: https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers
- Messaging limits: https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits
- Throughput: https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput
- Pricing: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
- Webhooks getting started: https://developers.facebook.com/docs/graph-api/webhooks/getting-started
- WhatsApp webhooks: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview
