# Gotham Renewal — architecture

**Version 2.** Supersedes the Phase-1 draft of this file (in git history). That
version described the plan; this one describes the system as built, and every
claim here is checked against the code. The 12 records in
[`docs/adr/`](adr/) remain the authoritative decision log — this file is the map,
the ADRs are the reasoning.

A **modular monolith**. One Next.js application, one PostgreSQL database, two
cron-triggered route handlers. No message queue, no cache server, no second
service. The only infrastructure beyond Postgres is a managed Redis used solely
for distributed rate limiting, and even that degrades rather than fails.

---

## 1. Why this shape

The business is a family store. Peak load is a day's orders, not a flash sale.
A monolith is the only shape where a single request is traceable by reading one
stack of files — which matters more here than any scaling property, because the
person maintaining it is also the person running the shop.

Modules are separated by **folder and interface**, not by process. That keeps the
option of extraction without paying for it today.

The rules that stop it becoming a ball of mud:

| Layer | Owns | Must not |
|---|---|---|
| `app/**/page.tsx`, `layout.tsx` | Rendering, calling a service | Touch Prisma directly |
| `app/api/**/route.ts` | Parsing, validation, status codes | Hold business rules or SQL |
| `lib/<domain>/service.ts` | Business rules, transaction boundaries | Know about HTTP |
| `lib/<domain>/repository.ts` | The only code that queries that domain's tables | Contain business rules |
| `lib/payments`, `lib/whatsapp` | One external provider each | Leak into request paths |

## 2. Runtime split

| Code | Runs in | Notes |
|---|---|---|
| Server Components (`app/**`, no `"use client"`) | Next.js server | Read the DB through services |
| `"use client"` components | Browser | Interactivity only: cart, checkout, admin forms |
| `app/api/**/route.ts` | Next.js server | The trust boundary; the only place secrets are used |
| `lib/**` | Next.js server (mostly) | Domain/state modules import `server-only`; pure and transport modules are portable — see below |
| Worker (`lib/notifications/worker.ts`) | Next.js server, from a cron | Sends notifications after the order committed |
| Razorpay | Their servers → our webhook | We never trust their redirect, only the signed webhook |
| Meta | Our server → Meta | Outbound only, never from the browser |

The `server-only` marker is the enforcement, and where it sits is a deliberate
line. Modules that touch the database, environment, logger or provider state
import it — `lib/db`, `lib/env`, `lib/logger`, `lib/rate-limit`, `lib/notifications`,
`lib/orders`, `lib/products`, `lib/payments/events`, `lib/payments/refunds`,
`lib/auth`, `lib/jobs` — so importing one from a Client Component is a **build
error**, not a shipped credential.

Two seams are deliberately **exempt**, because a transport module should be
testable without a server: `lib/whatsapp/` and `lib/payments/razorpay/`, together
with the pure modules (`lib/money`, `lib/cart/store`, `lib/orders/pricing`,
`lib/payments/decision`, `lib/payments/refund-eligibility`). They take their
configuration as a parameter and import no database. That is why the unit suite
can prove pricing, the decision table and refund eligibility with no
infrastructure at all.

## 3. Money

Every monetary value is an integer number of **paise** (`lib/money.ts`).
Rupees appear only at two edges: formatting for display (`formatPaise`) and
parsing what an admin types. Nothing in between is a float. Float arithmetic on
money is the one class of bug that is both invisible and expensive.

## 4. Data model

Seven models, seven enums. Enums exist so the database, TypeScript and the UI
share one vocabulary — no state is ever a bare string.

```
Product      id, name, slug(unique), description, price(paise), stock,
             imageUrl, active, version, createdAt, updatedAt
Order        id, orderNumber(unique), customer{...}, address{...},
             subtotal/shipping/total(paise), paymentMethod, paymentStatus,
             orderStatus, razorpayOrderId(unique), razorpayPaymentId, timestamps
OrderItem    orderId, productId(nullable), productName, quantity, unitPrice, total
Counter      id, value                          -- gap-free order numbers
Notification orderId, channel, type, status, recipient, payload,
             attempts, lockedAt, nextAttemptAt, providerMessageId, lastError
PaymentEvent orderId, provider, providerEventId, eventType, payload,
             processedAt                        -- UNIQUE(provider, providerEventId)
Refund       orderId, provider, paymentId, providerRefundId, amount(paise),
             status, idempotencyKey(unique), attempts, lastError, completedAt
```

Three properties carry real weight:

- **`OrderItem` is a snapshot.** `productName` and `unitPrice` are copied at
  purchase, not joined. A later rename or reprice cannot rewrite history, and an
  `OrderItem` surviving its product (via `ON DELETE SET NULL`) keeps old orders
  intact.
- **`Counter` gives gap-free order numbers** (`GR-0001`) using
  `UPDATE … RETURNING` inside the order transaction. It costs a row lock per
  order and buys a sequence the shop can trust.
- **`Product.version`** is the optimistic-concurrency token, bumped by *every*
  stock write — including the customer purchase path, which is what makes a
  stale admin edit detectable (ADR-0012).

## 5. Storage decisions

**Business entities → one PostgreSQL database** (Supabase in production).
Placing an order touches an order, its items, a stock reservation and a
notification obligation, and those must commit or roll back together. Prisma
cannot transact across two stores, so a second datastore would force a
hand-rolled distributed transaction to buy nothing. Trade-off accepted: Postgres
is a single scaling axis; read replicas come before a second store.

**Product images → object storage**, referenced by a URL string. Images are
read-often/written-rarely and belong on a CDN, not in `bytea` (which bloats the
database, backups, and every image request's connection). `product.image_url`
stays a plain string, so the backend is swappable.

**Razorpay → stateless.** Razorpay owns payment state. We keep only
`razorpay_order_id`, `razorpay_payment_id`, and one `payment_events` row per
webhook accepted. We never mirror their ledger and never treat a browser
redirect as proof of payment. The "who has paid" fact lives in exactly one place,
so there is nothing to reconcile.

**Notification state → the `notifications` table**, not a queue product. It is
an outbox: the job row is written inside the order transaction and sent
afterwards by a worker. See §6.

**Admin sessions → signed cookies**, not rows. No session table to read per
request, no expiry sweeper; revocation is by rotating the secret (ADR-0005).

**Rate-limit counters → managed Redis** (Upstash), because in-memory counters are
per-instance and Vercel runs several. Absent configuration it falls back to
in-memory and logs that it has — degraded, never broken.

## 6. The flows

### COD order

```
Browser  → POST /api/orders   { customer, items:[{productId, quantity}] }
                                     (ids and quantities ONLY — no prices)
  Zod validate → lib/orders/service.createOrder()
    load products from Postgres
    priceOrder()            pure: subtotal, shipping, total — integer paise
    $transaction:
      decrementStock()      guarded: UPDATE … WHERE stock >= qty
      nextOrderNumber()     UPDATE … RETURNING on Counter
      insert order + items  (items carry the snapshot)
      enqueueNotification() the alert to the owner, PENDING
  201 { order, accessToken }
```

The WhatsApp API is **not** called here. The obligation is recorded; the worker
sends it later.

### Razorpay order and settlement

```
Browser  → POST /api/orders   { paymentMethod: RAZORPAY }
  $transaction: reserve stock, insert order PENDING   (no alert yet)
  outside the transaction: createRazorpayOrder() → attachRazorpayOrderId()
  201 { order, razorpay:{ razorpayOrderId, keyId, amountPaise, currency } }

Browser  → Razorpay Checkout  → customer pays
Razorpay → POST /api/webhooks/razorpay
  raw body (request.text())            ← the signature covers these exact bytes
  verify HMAC (timingSafeEqual)
  parseWebhookEvent() → decidePaymentAction()      pure decision table
  $transaction:
    recordPaymentEvent()   INSERT … ON CONFLICT DO NOTHING on (provider, event_id)
                           zero rows returned = duplicate = stop, return 200
    mark paid / refunded / failed
    on capture: enqueue the owner alert
  200

Worker (cron, every minute)
  claimDueJobs()   SELECT … FOR UPDATE SKIP LOCKED + lease
  send via lib/whatsapp/client
  markSent | markFailed(backoff)
```

Two details worth stating plainly:

- The alert is queued by the **webhook on capture**, not at order creation, so an
  abandoned checkout does not page the shop. For COD it is queued at creation,
  because that order is actionable immediately. The unique `(order_id, type)`
  means it fires once either way (ADR-0008).
- A Razorpay failure does not fail the request. The order survives as `PENDING`
  with its stock held and is returned to the client so the customer can retry
  (ADR-0008).

### Refund

```
Admin → order page → "Issue full refund"
  server action: assertAdmin() → rate limit → issueRefund()
    re-read the order; verify eligibility FROM THE DATABASE
    beginRefund()      INSERT refund with a deterministic unique key  ← the lock
    sendRefund()       status = PROCESSING, then call the provider
                       (status is set BEFORE the call: a crash leaves it in
                        flight, so a later run reconciles instead of resending)
      provider ok            → SUCCEEDED + providerRefundId, order → REFUNDED
      definite 4xx           → FAILED          (safe to retry)
      timeout / 5xx          → stays PROCESSING (UNKNOWN — never retried blindly)
  uncertain → reconcile: fetch by id, else list the payment's refunds and match,
              and only when the provider has no record → FAILED → retryable
```

Idempotency has three independent layers: eligibility refuses an already-refunded
order; a unique `idempotency_key` makes concurrent clicks collide in the database;
and the same key is sent as the provider's refund `receipt`, which Razorpay treats
as its own idempotency key (ADR-0011).

### Abandoned-order sweep

```
cron (hourly) → GET /api/jobs/sweep-orders
  findStaleUnpaidOrders(> 60 min, RAZORPAY, PENDING, NEW|CONFIRMED)
  per order, in its own transaction:
    abandonUnpaidOrder()   guarded: WHERE still PENDING AND still NEW/CONFIRMED
    if it matched 0 rows → a payment landed first → do nothing, restock nothing
    if it matched 1 row  → restock the reserved units
```

Stock is reserved at order creation, so an abandoned checkout holds a unit. The
guard is what makes the sweep safe to run concurrently with a live payment: the
webhook and the sweep race on the same row, and Postgres picks one winner.

## 7. The invariants, and what enforces each

This is the part that matters. Each risk has exactly one mechanism, named in
`AGENTS.md` so it is not re-litigated in future work.

| Risk | Mechanism | ADR |
|---|---|---|
| Client tampers with price or total | Order schema has no price field; server reads the DB | 0004 |
| Two buyers take the last unit | `UPDATE … WHERE stock >= qty` — atomic under a row lock | 0003 |
| Duplicate webhook applies twice | DB unique on `(provider, event_id)` + `ON CONFLICT DO NOTHING` | 0002 |
| Browser reports "paid" | Only the HMAC-verified raw-body webhook sets `PAID` | 0002 |
| Meta outage fails an order | Outbox: the obligation is committed, sent afterwards | 0006 |
| Notification lost to a crash | Lease-based claim + `SKIP LOCKED`; a lapsed lease is reclaimed | 0006 |
| Timestamps silently shifted | Session pinned to UTC; integers, never JS `Date`, in raw SQL | 0007 |
| Failed payment start loses the order | Order kept `PENDING`, returned for retry | 0008 |
| Stale admin edit erases a sale | `version` guard → `stale-edit`, never forced | 0009, 0012 |
| Double refund | Eligibility + unique key + provider receipt | 0011 |
| Refund timeout refunds twice | `PROCESSING` + reconcile; never a blind retry | 0011 |
| Order ids enumerated | Signed, expiring, order-bound access token | — |
| Admin endpoint called directly | Guard inside every page **and** every action | 0005 |
| Soft 404s on disabled products | No `loading.tsx` above a route that can `notFound()` | 0010 |

## 8. Security posture

- **Admin auth.** One password, verified server-side against `ADMIN_PASSWORD`
  (plaintext for local, a scrypt hash in production). The session is a signed
  cookie: `HttpOnly`, `SameSite=Lax`, `Secure` in production, 12-hour expiry.
  The guard is called inside every admin page and every server action, not only
  in the layout or a proxy — server actions are individually addressable POST
  endpoints (ADR-0005).
- **Order access.** `/order-success/[id]` requires a signed, expiring,
  order-bound token (7 days). An order id is not a secret: it appears in history,
  `Referer` headers and logs. Every failure returns the same 404.
- **Webhook.** HMAC-SHA256 over the raw body, constant-time comparison, verified
  before any database work.
- **Secrets.** Server-side only; no secret is ever read through `NEXT_PUBLIC_*`.
  The Supabase service-role key is used solely by the upload route.
- **Headers.** `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`,
  `Permissions-Policy`, HSTS in production, and a CSP in report-only mode
  (enforcing it without observing real Razorpay traffic would risk silently
  breaking checkout).
- **Rate limits.** Admin login 5/5min, order creation 10/min, refunds 10/min,
  image uploads 20/min. The Razorpay webhook is deliberately **not** limited — a
  legitimate provider retry must never be rejected; it is protected by signature
  and idempotency instead.
- **Errors.** Production responses carry a digest, never a stack trace. Verified.
- **Logs.** Order events log ids and totals, not customer PII. No token or secret
  is ever logged.

## 9. Deployment topology

```
Browser → Vercel (Next.js)
            ├─ server components / route handlers ──┐
            ├─ cron: /api/jobs/notifications (1m)   │  DATABASE_URL  (pooler :6543)
            └─ cron: /api/jobs/sweep-orders   (1h)  ├─→ Supabase Postgres
                                                     │  DIRECT_URL    (direct :5432, CLI only)
Razorpay ── signed webhook ─────────────────────────┘
Meta     ← WhatsApp Cloud API (from the worker)
Upstash  ← rate-limit counters (optional)
Supabase Storage ← product images (optional)
```

Two connection strings, and they are not interchangeable: the **transaction
pooler** is right for queries but cannot run a migration (it may hand each
statement to a different backend), so the Prisma CLI uses the **direct**
connection. `prisma.config.ts` reads `DIRECT_URL` for the CLI; the app reads
`DATABASE_URL`. Prisma 7 removed `directUrl` from the schema, which is why the
split lives there.

`npm run build` runs `prisma generate && next build`, because Vercel builds from
a clean checkout that has no generated client.

See [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) for the runbook and the staging
smoke-test procedure.

## 10. Test strategy

`npm test` is the unit suite and must stay fast and **database-free** — 160 tests
covering money, pricing, validation, the order-status machine, the payment
decision table, refund eligibility, rate-limit behaviour and upload rules.

Everything requiring the real world is a `check:*` script, run with Postgres (and
sometimes a browser) available. They exist because a mock cannot prove that two
concurrent transactions clash, or that a crashed worker's job is recoverable:

| Check | Proves |
|---|---|
| `check:oversell` | 10 concurrent requests for 1 unit → exactly one wins |
| `check:outbox` | Rollback leaves no orphan job; a dead worker's job is reclaimed; an outage leaves the order intact |
| `check:webhook-idempotency` | 12 concurrent duplicate deliveries → one application |
| `check:webhook-route` | Real HMACs over HTTP; tampered bodies refused; browserless settlement |
| `check:sweep` | A paid order is never cancelled or restocked |
| `check:orders` | Both payment paths, snapshots, refusals, failed-provider survival |
| `check:products` | Rupees→paise, disable-not-delete, stale-edit refusal |
| `check:refunds` | 8 concurrent clicks → one refund; timeout never retried blindly |
| `check:e2e`, `check:admin-browser`, `check:products-browser` | Real Chrome: checkout and admin flows |

The two browser harnesses drive Chrome over the DevTools Protocol with Node's
built-in `WebSocket`, so they add no dependency.

## 11. Deliberately not built

Kafka (no event volume), a cache layer (Postgres indexes first — the Redis we
added is for rate limiting only), a separate worker service (a cron-triggered
route is enough), Elasticsearch (Postgres full-text search), microservices (one
deployable), GraphQL (REST route handlers match the data shapes exactly).

Each needs a demonstrated requirement before it appears. The corollary is that
things that *were* deferred are recorded as deferred in
[`PROCESS.md`](PROCESS.md), not disguised as complete.

## 12. Status

**Code-complete and locally verified.** Every invariant in §7 has a runnable
check, and the full gate is green: 160 unit tests, 8 database checks, 4
browser/HTTP checks, clean typecheck, lint and production build.

**Database: verified in place against the real host.** The app runs against
Supabase Postgres in Mumbai (`ap-south-1`), with all 5 migrations applied and the
7 tables and 7 enums present. `npm run check:database` passes 10/10 *through the
transaction pooler*, and every concurrency and durability check —
`check:oversell`, `check:outbox`, `check:webhook-idempotency`, `check:sweep`,
`check:orders`, `check:products`, `check:refunds` — passes against Supabase. That
matters because a transaction pooler is a new variable for `FOR UPDATE SKIP
LOCKED` and row-level locking, and those guarantees are load-bearing.

The connection-parameter timezone concern is **resolved**: `DB_SESSION_UTC=false`
means the pooler is never handed an `options` startup parameter, and
`ALTER DATABASE postgres SET timezone='UTC'` makes UTC a property of the database
itself. The timestamp round-trip check compares against real UTC and passes.

**Not staging-verified and not production-verified.** No other external
integration — Meta, Razorpay, Vercel, or Storage — has been exercised against
real accounts from here. The remaining unverifiable-locally item is whether the
CSP would break Razorpay Checkout, which is why it ships report-only. See
`DEPLOYMENT.md`.
