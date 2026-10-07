# Build & collaboration notes

## Purpose of this file

Durable context for whoever (human or agent) picks this project up next: how the
work is sequenced, where the persistent memory lives, and the conventions that
must not drift. The Next.js-specific agent rules live in the managed block in
[AGENTS.md](AGENTS.md); read those first for framework conventions.

---

## Persistent memory files

| File | Owns | Update when |
|---|---|---|
| `CONTEXT.md` | The domain glossary. What our words mean. No implementation detail. | A term is introduced, renamed, or a fuzzy word is sharpened. |
| `docs/adr/*.md` | Decisions that are hard to reverse, surprising, and a real trade-off. | A decision of that weight is made. |
| `docs/research/*.md` | Primary-source research for external integrations (Prisma, Razorpay, WhatsApp). | An integration's facts change, or a new provider is added. |
| `docs/ARCHITECTURE.md` | The system shape and the request flows. | The architecture changes. |
| `docs/PROCESS.md` (this file) | How we work. | The working agreement changes. |

Read `CONTEXT.md` before writing user-facing copy or naming a table. Use its
vocabulary in code, tests, and commits.

## Storytelling rule

Every phase is taught, not just shipped: build it, then explain what it is, why
it is shaped that way, where each piece executes, the commands to run, the env
vars it needs, how to test it, and the mistakes it avoids. Stop at a working
checkpoint before the next phase.

## Parallelisation rules

The phases are a **dependency chain**, not a parallel set. Orders reference
products; checkout references both. Running dependent phases concurrently
produces code that cannot compile, so the backbone is serialised.

What *is* safe to run in parallel is dependency-free leaf work:

| Parallelisable | Why it is safe | Phase |
|---|---|---|
| WhatsApp client + templates | Talks to Meta; never touches the database or order code | 9 |
| Razorpay client (create order, verify signature) | Provider-shaped; its only inputs are a number and ids | 10 |
| Cart state (client-side) | Browser state; no database, no server contract yet | 4 |
| Research for an integration | Reads docs; writes to `docs/research/` only | any |

Rules for a parallel task:

1. **One file per concern.** A leaf task owns `lib/<provider>/*.ts` and its test.
   It must not edit shared files, the Prisma schema, or another task's files.
2. **Define the seam, not the whole journey.** A parallel task builds the
   reusable client and its unit tests with mocked HTTP. Wiring it into an order
   flow stays on the serial backbone.
3. **No schema changes off the backbone.** Migrations are strictly serial.
4. **Verify independently.** Each task leaves a runnable check behind and must
   pass `npm run typecheck && npm run lint && npm test` on its own.

## The canonical phase order

```
1  foundation            ✅ done
2  products + catalogue  ✅ done
3  product detail        ✅ done
4  cart + cart UI        ✅ done
5  checkout              ✅ done
6  orders + order_items  ✅ done
7  COD ordering          ✅ done
8  admin auth + dashboard ✅ done
9  WhatsApp Cloud API    ✅ client + templates + outbox/worker (needs Meta template to send)
10 Razorpay              ✅ checkout wired end to end
11 webhook verification + idempotency ✅ route + DB constraint + concurrency tested
12 inventory transactions ✅ cancellation restock + abandoned-order sweep
13 product management    ✅ admin CRUD, disable, stock
14 deployment            ✅ docs/DEPLOYMENT.md + pooler/migration split + build hook
15 testing + hardening   ✅ error boundaries, refund surfacing, order integration test
16 production-readiness  ✅ explicit refund workflow, distributed rate limiting, optimistic stock concurrency, image uploads, security headers
17 deployment            ✅ LIVE on Vercel (bom1) + Supabase Mumbai; COD verified in production
18 admin visibility      ✅ notifications/outbox, refunds, customers views
```

**All fifteen phases are complete.** What remains is external configuration, not
code: the Meta template, the Razorpay dashboard, and the production deploy. See
[docs/DEPLOYMENT.md](DEPLOYMENT.md).

Phases 4, 9 and 10 were pulled forward in parallel because they are leaves: the
cart is browser-only, and the WhatsApp and Razorpay modules talk to an external
provider and take their inputs as parameters. Their **wiring into the order flow**
still happens on the backbone in Phases 5-11.

### Parallel leaf modules already in place

| Module | Location | Wired in by |
|---|---|---|
| Cart state (pure store + React context) | `src/lib/cart/` | Phase 5 (checkout) |
| WhatsApp Cloud API client + templates | `src/lib/whatsapp/` | Phase 9 (notification service) |
| Razorpay REST client + webhook verify | `src/lib/payments/razorpay/` | Phase 10-11 |

Each is dependency-free (no `@/lib/env`, no Prisma) and takes configuration as an
explicit parameter, which is why they could be built and tested independently.

## Known gaps to close later

Everything here is a deliberate deferral with its reasoning, not an oversight.

- **A late payment needs a human.** The sweep cancels unpaid orders after an
  hour; if money arrives afterwards the webhook leaves the order `CANCELLED` +
  `PAID`. The dashboard surfaces these in red and
  `/admin/orders?filter=refund` lists them. Issuing the refund is now an explicit
  admin action (ADR-0011), deliberately not automatic.
- **Refunds are full-order only.** Partial refunds, disputes and chargebacks are
  out of scope. A refund in the `PROCESSING` state must be reconciled, not
  retried — the refunds view surfaces these and offers the reconcile action
  inline.
- **The rate limiter falls back to in-memory if Upstash is unconfigured.** It
  logs which backend is active at startup. In-memory is per-instance, so on
  Vercel the real limit is multiplied by the number of warm instances. Set
  `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` for the distributed
  limiter.
- **The Content-Security-Policy is report-only.** It observes violations without
  enforcing, because a wrong CSP breaks Razorpay Checkout silently. Flip it to
  enforcing once the reports are clean (see `next.config.ts`).
- **Admin stock edits are optimistic, guarded on a version column.** A stale
  save - including one raced by a customer purchase - is refused with
  `stale-edit` rather than overwriting (ADR-0009 updated, ADR-0012).
- **The Razorpay webhook has not met the real provider's delivery.** Signature
  verification is exercised locally with real HMACs and an incorrect-credential
  call was made to Razorpay's live API (which correctly refused it), but the
  dashboard webhook itself must be configured and a test-mode payment completed
  before go-live. Razorpay blacklists `localhost`/`ngrok.io`; use cloudflared.
- **Admin time handling.** "Started 3d ago" on the refunds view uses `Date.now()`
  at render, so it is relative to the viewer's clock rather than the server's.
  Correct in practice (they are the same machine's clock for a single admin), but
  worth knowing if the server clock is ever skewed.

- ~~`DB_SESSION_UTC` unverified on Supabase~~ — **RESOLVED (verified in place).**
  Supabase Mumbai runs UTC. `DB_SESSION_UTC=false` is set (the pooler is never
  handed an `options` startup parameter) and `ALTER DATABASE postgres SET
  timezone='UTC'` makes UTC a property of the database. `npm run check:database`
  passes 10/10 through the real transaction pooler, including the timestamp
  round-trip against real UTC.
- **Admin session revocation is by secret rotation.** No per-session revoke.
- **The WhatsApp template must exist and be approved in Meta Business Manager.**
  Until then, sends fail and the outbox correctly keeps the job retryable.
- **Notifications can lag up to a minute** (cron granularity).
- **Product images are URLs, not uploads.** No file upload or storage integration.
- **Rate limiting is in-memory, per server instance.** Best-effort, documented in
  `lib/rate-limit.ts`. A real limit needs Postgres or Redis.
- **The `db:seed` script is not idempotent about deletes.** It upserts by slug,
  so it will not duplicate, but it never removes products you deleted by hand.

## Verification contract

A phase is not done until, from a clean shell:

```bash
nvm use
npm run typecheck     # clean
npm run lint          # clean
npm test              # green
npm run build         # compiles
```

Plus the phase's own manual check (a curl, a page, or a query). "It compiles" is
not verification; demonstrate the behaviour.

## Testing notes

- `npm test` runs `node --conditions=react-server --import tsx --test`. The
  `react-server` condition is **required**: it makes `server-only` resolve to its
  no-op (as it does in a real Next server build), so modules that import the
  logger can be unit-tested. Without it every `server-only` import throws.
- Node's test runner discovers `**/*.test.ts` recursively, so tests live beside
  the code they cover. Test files run under plain Node — they must not import
  React or `.tsx`.
- External HTTP (Meta, Razorpay) is always stubbed via `globalThis.fetch` in
  tests. No unit test makes a real network call.
- The database is not touched by unit tests.

### Checks that need the real world

These are excluded from `npm test` (which must stay fast and database-free) by
not ending in `.test.ts`. Run them by hand while the dev server is up:

| Command | What it proves | Needs |
|---|---|---|
| `npm run check:oversell` | 10 concurrent requests for 1 unit → exactly 1 wins, stock never negative. This is the overselling defence, and a mock cannot prove it. | Postgres running |
| `npm run check:e2e` | A real Chrome goes product → cart → checkout → confirmation, and the cart persists and then clears. The only check that exercises React, the cart context and localStorage — where wiring bugs hide. | Postgres + `npm run dev` |
| `npm run check:admin` | Over HTTP: signed-out `/admin` redirects to login, a forged session cookie is refused, a wrong password sets no cookie, cancelling returns stock, and an illegal transition is refused. | Postgres + `npm run dev` |
| `npm run check:admin-browser` | A real Chrome signs in through the form, the cookie comes back HttpOnly (page JS cannot read it), clicking a status button advances the order, and signing out re-protects `/admin`. This is the only way to test a server action, which needs the browser's Next-Action protocol. | Postgres + `npm run dev` + plaintext `ADMIN_PASSWORD` |
| `npm run check:outbox` | Notification durability: a rolled-back order leaves no job, a committed order does, a crashed worker's job is reclaimed after its lease lapses (**and is NOT stolen while the lease is live**), a WhatsApp outage leaves the job retryable and the order untouched, and a duplicate alert is refused by the unique constraint. | Postgres |
| `npm run check:webhook-idempotency` | 12 **concurrent** identical webhook deliveries → exactly one is applied. Also that a failed payment application rolls its event row back (so an order can never get stuck unpaid), and that the unique key is `(provider, event_id)`. | Postgres |
| `npm run check:webhook-route` | The webhook **route**, over HTTP with real HMAC signatures: unsigned/wrongly-signed/tampered bodies are refused before any database work, a valid capture marks the order PAID and queues exactly one alert, redelivery and 8 concurrent redeliveries change nothing, and an unmatched order is ignored without a retry loop. | Postgres + `npm run dev` + `RAZORPAY_WEBHOOK_SECRET` |
| `npm run check:sweep` | The abandoned-order sweep never harms money: a stale unpaid order is cancelled and restocked, a stale **paid** order is untouched with its stock intact, COD is never swept however old, and the guarded update refuses to abandon an order a payment just landed on. | Postgres |
| `npm run check:products` | Product admin at the service layer: rupees→paise conversion, create, duplicate slug refused without throwing, absolute stock set, negative stock refused, and a disabled product gone from the storefront but never deleted (order items keep their foreign key). | Postgres |
| `npm run check:products-browser` | The product admin **in a real browser**: create a product through the form and prove 450.50 rupees becomes 45050 paise in the database, disable it and prove the storefront 404s while the row survives, and set stock through the form. | Postgres + `npm run dev` + plaintext `ADMIN_PASSWORD` |
| `npm run check:orders` | Order creation at the service layer, both payment paths: money computed from database prices, stock reserved, items snapshotted, the owner alert queued for COD but **not** for an unpaid online order, refusals (empty / unknown / over-stock / inactive) leaving stock untouched, a historical order surviving a rename and reprice, and a failed Razorpay start still returning the saved order. | Postgres |
| `npm run check:database` | **The deploy gate.** 10 checks on whatever `DATABASE_URL` points at: session timezone is UTC, a JS `Date` is stored as the instant intended (compared against real UTC, not against itself), all 7 tables and 7 enums exist, 5 migrations applied, and the four unique constraints every guarantee rests on. Exits non-zero on failure. Run it before trusting a new database. | Postgres |

`check:e2e` and `check:admin-browser` drive Chrome over the DevTools Protocol
using Node's built-in `WebSocket`, so they add no dependency. Override the Chrome
path with `CHROME_BIN` and the server with `E2E_BASE_URL`.

### Draining the notification outbox

```bash
npm run jobs:notifications          # one pass
npm run jobs:notifications -- --loop # poll every 5s (local development)
```

In production, Vercel Cron calls `GET /api/jobs/notifications` every minute
(`vercel.json`), authenticated by `CRON_SECRET`.

### Sweeping abandoned orders

Unpaid online orders reserve stock at creation (ADR-0003), so a customer who
abandons checkout holds a unit. `GET /api/jobs/sweep-orders` cancels those older
than an hour and returns the stock. Vercel Cron runs it hourly; a `?minutes=`
parameter narrows or widens the window for a manual run.

```bash
curl -H "Authorization: Bearer $JOB_RUNNER_SECRET" \
  'http://localhost:3000/api/jobs/sweep-orders?minutes=1'
```

The sweep is safe under concurrency, and the guarantee is tested: it only
cancels an order that is *still* unpaid and *still* uncancelled, via a guarded
update, so a payment landing at the same instant wins. A **late capture** — money
arriving after abandonment — leaves the order `CANCELLED` with
`paymentStatus = PAID`, which is a truthful state a human must refund. Silently
ignoring that money would be theft.

## Environment notes specific to this machine

- Node 24 LTS is required (Prisma 7 rejects Node 21). `.nvmrc` pins it.
- PostgreSQL 17 runs from **miniconda** (`~/miniconda3/bin`), not Homebrew,
  because `/opt/homebrew` is owned by another user and `brew install` fails
  without sudo. Start it with:
  ```bash
  export PATH="$HOME/miniconda3/bin:$PATH"
  pg_ctl -D ~/.local/share/pgdata/gotham -l ~/.local/share/pgdata/gotham/server.log start
  ```
  Data lives in `~/.local/share/pgdata/gotham`. Role `gotham`, database
  `gotham_renewal`, both created by `scripts/setup-db.sh`.
- `npm install` may warn that Prisma's install scripts are unapproved; the
  engines are already present and `npx prisma --version` works.
