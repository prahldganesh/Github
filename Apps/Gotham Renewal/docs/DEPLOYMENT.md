# Deployment

Target: **Vercel** (app) + **Supabase** (PostgreSQL). This is the runbook.

---

## 1. Create the Supabase project

1. Create a project at [supabase.com](https://supabase.com). Choose a region close
   to the customers (for India, `ap-south-1` / Mumbai).
2. Save the database password somewhere safe — it is shown once.

## 2. Get the two connection strings

Supabase's dashboard → **Connect** gives you several strings. You need two, and
they are **not** interchangeable:

| Purpose | Where | Port | Env var |
|---|---|---|---|
| Application queries | Transaction pooler | **6543** | `DATABASE_URL` |
| Migrations (Prisma CLI) | Session pooler / direct | **5432** | `DIRECT_URL` |

Why two: the transaction pooler multiplexes many clients onto few Postgres
connections, which is right for serverless queries but **cannot run a
migration** — a migration needs one session across many statements and takes
advisory locks, and a transaction-mode pooler may give each statement a different
backend. `prisma.config.ts` reads `DIRECT_URL` for the CLI and the app reads
`DATABASE_URL`. See ADR-0007's sibling note in that file.

```
# Use the plain strings from the dashboard. No extra query parameters.
DATABASE_URL="postgres://postgres.[REF]:[PASSWORD]@[HOST]:6543/postgres"
DIRECT_URL="postgres://postgres.[REF]:[PASSWORD]@[HOST]:5432/postgres"
```

**A password containing special characters must be encoded — twice if it
already contains a `%`.** This bit us in practice. Supabase's dashboard shows
the password already URL-encoded once, so a literal `&` in your password appears
there as `%26`. If the password itself contains a literal `%` character, that
`%` must then be encoded as `%25` before it goes into a connection URL — the
percent is the escape character, and an unescaped one makes the driver decode
bytes that were never encoded. The symptom is
`FATAL: password authentication failed for user "postgres"`, which reads like a
wrong password but is an encoding problem. Test the string with `psql` before
trusting it:

```bash
psql "$DIRECT_URL" -tAc "select current_setting('TimeZone')"   # expect UTC
```

`DIRECT_URL` is only read by the CLI, so it does **not** need to be set on
Vercel — but it is harmless there.

**On `?pgbouncer=true&connection_limit=1`:** those are Prisma-engine options.
With Prisma 7's `@prisma/adapter-pg`, pooling is handled by node-postgres and the
adapter does not use cached prepared statements, so they are inert. This
deployment was verified **without** them - the plain dashboard strings work. Add
a parameter only if an error explicitly names it.

## 3. Run the migrations

From your machine, with `DIRECT_URL` pointing at the production database:

```bash
DIRECT_URL="postgres://...:5432/postgres" npx prisma migrate deploy
```

`migrate deploy` applies the committed migrations in order and does nothing if
the database is already current. It is the only migration command that belongs in
a deploy; never run `migrate dev` against production — it can reset the database.

Then seed the catalogue if it is a fresh database:

```bash
DIRECT_URL="postgres://...:5432/postgres" npm run db:seed
```

## 4. Set the environment variables on Vercel

Project → Settings → Environment Variables. Every one of these is server-side;
**none** may be prefixed `NEXT_PUBLIC_`.

| Variable | Value / how to generate |
|---|---|
| `DATABASE_URL` | The transaction-pooler string above |
| `APP_BASE_URL` | `https://your-domain.com` — no trailing slash |
| `ADMIN_PASSWORD` | `npm run admin:hash -- "a long password"` — paste the `scrypt$…` output, NOT plaintext |
| `ADMIN_SESSION_SECRET` | `node -e "console.log(crypto.randomBytes(32).toString('hex'))"` |
| `JOB_RUNNER_SECRET` | `node -e "console.log(crypto.randomBytes(24).toString('hex'))"` |
| `CRON_SECRET` | Same value as `JOB_RUNNER_SECRET` (Vercel Cron sends this one) |
| `ORDER_NUMBER_PREFIX` | `GR` |
| `ORDER_NOTIFICATION_NUMBER` | The owner's WhatsApp number, digits only, e.g. `919876543210` |
| `SHIPPING_FEE_PAISE` | e.g. `5000` for ₹50. `0` for free |
| `FREE_SHIPPING_THRESHOLD_PAISE` | e.g. `100000` for free over ₹1000. `0` disables |
| `RAZORPAY_KEY_ID` / `_KEY_SECRET` | Live keys (`rzp_live_…`) once tested; test keys before |
| `RAZORPAY_WEBHOOK_SECRET` | From the Razorpay webhook you create in step 6 |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta WhatsApp → API Setup |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Meta WhatsApp → API Setup |
| `WHATSAPP_ACCESS_TOKEN` | A **System User** token, not the 24-hour one |
| `META_GRAPH_VERSION` | e.g. `v21.0` |
| `LOG_LEVEL` | `info` |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Optional but **recommended**: without them rate limiting is per-instance. Create a free database at upstash.com and copy the REST URL and token. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_STORAGE_BUCKET` | Optional: enables the product image uploader. Create a **public** bucket (default name `product-images`). The service-role key is server-side only. |

`DB_SESSION_UTC` is optional — see step 7.

### Which rate limiter is active?

The app logs it on the first request:

```
[rate-limit] distributed backend active (Upstash Redis)
[rate-limit] using the IN-MEMORY backend (per-instance). Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for a real distributed limit.
```

If you see the second line in production, the limit is not real across
instances. That is a warning, not a failure — requests are still served.

## 5. Deploy

```bash
vercel --prod
```

`npm run build` runs `prisma generate && next build`, so the client is generated
before the app compiles. Vercel Cron jobs are picked up from `vercel.json`
automatically on a production deploy.

## 6. Point Razorpay at the webhook

Razorpay dashboard → Settings → Webhooks → add:

- **URL**: `https://your-domain.com/api/webhooks/razorpay`
- **Secret**: generate one, then set it as `RAZORPAY_WEBHOOK_SECRET`
- **Events**: `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`

Razorpay will not deliver webhooks to `localhost` or `ngrok.io`. For local
end-to-end testing use Cloudflare Tunnel and put the tunnel URL in the dashboard
temporarily.

## 7. Verify the deployment

### 7a. The database itself

Run the database gate **before** trusting the app. It checks the things that
fail silently — a non-UTC session, a missing migration, an absent unique
constraint — and exits non-zero, so it works as a deploy gate.

```bash
npm run check:database
```

It reports which host it connected to (without printing the password) and runs
10 checks. The one that matters most is the timestamp round-trip: it asks
Postgres what instant it actually received and compares that to the instant we
intended, rather than comparing a value to itself. A round-trip through the ORM
looks fine while the data is 5.5 hours wrong — that is exactly how this class of
bug hid before.

What a healthy run looks like:

```
Target: <host>:<port>/<db>

PASS  the session timezone is UTC — UTC
PASS  a JS Date is stored as the instant we intended (UTC) — 2026-10-05T07:00:33
PASS  all 7 tables exist
PASS  all 7 enums exist
PASS  migrations have been applied — 5 applied
PASS  payment_events is unique on (provider, provider_event_id)
PASS  refunds is unique on idempotency_key
PASS  notifications is unique on (order_id, type)
PASS  orders.order_number is unique
PASS  products.version exists

10/10 checks passed.
```

### 7b. The session timezone on Supabase

Supabase runs UTC, so the app's `options=-c timezone=UTC` parameter is redundant
there. Two belt-and-braces steps remove the last unverified piece:

1. Set `DB_SESSION_UTC="false"` in the environment, so the pooler is never handed
   a startup parameter it might not forward.
2. Run once in the Supabase SQL editor, so UTC is a property of the database
   regardless of connection path:

   ```sql
   ALTER DATABASE postgres SET timezone = 'UTC';
   ```

Then re-run `npm run check:database` and confirm **10/10**. Do not set
`DB_SESSION_UTC=false` while still pointed at a non-UTC server — the check above
will catch it, but the failure mode is silent data corruption.

### 7c. The app

```bash
curl -s https://your-domain.com/api/health
# {"status":"ok","database":"up","latencyMs":...}
```

Then walk the real flow:

- [ ] `/` loads; the catalogue shows your products
- [ ] Add to cart → checkout → **COD order** succeeds
- [ ] The owner's WhatsApp receives the alert (within ~1 minute — the cron)
- [ ] `/admin` requires the password; wrong password is refused
- [ ] `/admin/orders` lists the order; changing its status works
- [ ] `/admin/products` can add a product; the storefront shows it
- [ ] A **test-mode Razorpay** order: pay with a test card, then confirm the order
      flips to `PAID` in `/admin/orders` — this proves the webhook end to end
- [ ] The confirmation page is reachable with its token and 404s without it
- [ ] **Refund (test mode):** put a test-paid order into CANCELLED from
      `/admin/orders`, confirm the red "needs a refund" alert, open the order,
      issue the refund, and confirm the provider refund id is recorded; then
      click again and confirm it is refused as already refunded
- [ ] **Stale stock:** open a product edit page in two tabs, save in both, and
      confirm the second is refused with a "changed by someone else" message
- [ ] The app logs "distributed backend active (Upstash Redis)"
- [ ] Security headers are present on `/` (see the smoke test below)

## 8. Production-readiness checklist

**Security**
- [ ] `ADMIN_PASSWORD` is a scrypt hash, not plaintext
- [ ] `ADMIN_SESSION_SECRET` and `JOB_RUNNER_SECRET` are fresh random values, not the dev ones
- [ ] No secret is prefixed `NEXT_PUBLIC_`
- [ ] The Razorpay **live** keys are in place only after test-mode verification
- [ ] The WhatsApp token is a System User token, not the 24-hour one
- [ ] `/admin` is `noindex` (it is, via metadata)

**Money and data**
- [ ] A test payment flips the order to `PAID` via the webhook, not the browser
- [ ] A duplicate webhook delivery does not double-apply (`check:webhook-idempotency` locally)
- [ ] Prices are integer paise in the database (spot-check a product row)
- [ ] Order items keep their snapshot after renaming a product
- [ ] A COD order's WhatsApp alert arrives

**Operations**
- [ ] Both cron jobs appear in the Vercel dashboard (Notifications hourly, Sweep hourly)
- [ ] Vercel Cron env var `CRON_SECRET` is set, or the crons 401 silently
- [ ] `LOG_LEVEL=info`; errors are visible in Vercel's log viewer
- [ ] A database backup/point-in-time-recovery is enabled on Supabase (it is by default on paid plans — confirm on free)
- [ ] Uptime monitoring on `/api/health`

**Before taking real money**
- [ ] The Meta `new_order_alert` template is **Approved** (see `lib/whatsapp/templates.ts` for its exact body)
- [ ] `ORDER_NOTIFICATION_NUMBER` is the owner's real number, and a test send arrived
- [ ] Test the full refund path in the Razorpay dashboard once (our code records a refund but does not initiate one)

---

## Rolling back

The app rolls back on Vercel by redeploying a previous build. **The database does
not roll back automatically** — migrations are forward-only. If a migration must
be undone, write a new migration that reverses it; do not edit an applied one.

---

## Known production caveats

Carried from the build, listed so they are decisions rather than surprises:

- **Notifications can lag up to a minute** (cron granularity). The order is
  committed immediately; only the alert waits.
- **An abandoned online order holds its stock for up to an hour** before the
  sweep releases it (ADR-0003).
- **A payment arriving after abandonment** leaves the order `CANCELLED` + `PAID`,
  which needs a manual refund. No alert fires for this yet.
- **Refunds are recorded, not initiated.** The webhook sets `REFUNDED`; starting
  a refund is a Razorpay dashboard action.
- **Product images are URLs, not uploads.** There is no file upload.


---

## Staging smoke-test procedure

The full end-to-end acceptance run against a **deployed staging environment**
(not localhost). Each step names what to check and where, so a failure is easy to
localise.

Set `BASE=https://your-staging-domain` and substitute your cron secret.

### 0. Foundations

```bash
curl -s $BASE/api/health
# {"status":"ok","database":"up",...}
```

```bash
curl -s -D - -o /dev/null $BASE/ | grep -iE 'x-frame-options|content-security|x-powered-by'
# expect X-Frame-Options: DENY, a CSP, and NO X-Powered-By
```

Confirm the log line for the rate-limit backend (Upstash or in-memory).

### 1. Catalogue

- [ ] Home page loads and lists products
- [ ] `/products` lists the catalogue; a product opens at `/products/<slug>`
- [ ] Add to cart; the header badge increments; the cart survives a refresh

### 2. COD order

- [ ] Complete checkout with cash-on-delivery
- [ ] Confirmation page shows the order and the order number
- [ ] Database: `select order_status, payment_status from orders where order_number='...'` → `NEW`, `COD`
- [ ] Stock decreased by the ordered quantity
- [ ] `/admin/orders` shows the order
- [ ] `select status from notifications where order_id='...'` → a `PENDING` or `SENT` row
- [ ] The owner's WhatsApp receives the alert (within ~1 minute)

### 3. Razorpay (test mode)

- [ ] Complete checkout choosing online payment; Razorpay Checkout opens
- [ ] Pay with a Razorpay test card
- [ ] The browser lands on the confirmation page
- [ ] **Independently** confirm the webhook was processed: the order's
      `payment_status` is `PAID` and its `razorpay_payment_id` is set
- [ ] `select count(*) from payment_events where order_id='...'` → `1`
- [ ] Stock is unchanged by the webhook (it moved at order creation)
- [ ] A second notification is not queued (the alert was queued by the webhook,
      once)

### 4. Webhook replay

Replay the same signed event from the Razorpay dashboard ("Resend"):

- [ ] The response is `200` with `"duplicate": true`
- [ ] `payment_events` still has exactly one row for the order
- [ ] The order's payment status did not change again
- [ ] No second notification was queued

### 5. Admin

- [ ] `/admin` requires the password; a wrong password is refused
- [ ] A signed-out request to `/admin/orders` redirects to login
- [ ] The order list and detail render; changing the status works
- [ ] Editing a product saves; the storefront reflects it
- [ ] Disabling a product 404s its storefront page
- [ ] **Stale stock conflict:** two tabs, save both — the second is refused
- [ ] Sign out; `/admin` redirects again

### 6. Refund

- [ ] Create a test-mode paid order, then cancel it from the admin
- [ ] The dashboard shows the "needs a refund" alert
- [ ] Issue the refund from the order page
- [ ] The provider refund id is recorded on the order
- [ ] The order's payment status is `REFUNDED`
- [ ] Clicking "Issue refund" again is refused (already refunded)
- [ ] Razorpay's dashboard shows exactly one refund for the payment

### Recording the result

Note the date, the staging URL, and any step that failed. A step that could not be
run for lack of credentials is recorded as **not verified**, not as passed.
