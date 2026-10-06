<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Gotham Renewal — agent notes

Read these before changing anything. They are the short version; the linked files
hold the detail.

## Where the context lives

| File | Read it for |
|---|---|
| `CONTEXT.md` | The domain glossary. Use this vocabulary in code, tests, and commits. |
| `docs/ARCHITECTURE.md` | The system shape, the runtime split, and the request flows. |
| `docs/PROCESS.md` | Build order, parallelisation rules, and machine-specific setup. |
| `docs/adr/` | Decisions that are deliberate. Do not "fix" these without reading them. |
| `docs/research/` | Primary-source facts for Prisma, Razorpay, and WhatsApp. |

## Hard rules

- **Money is integer paise.** Never a float number of rupees. See `src/lib/money.ts`.
- **The server is authoritative.** The browser sends product ids and quantities,
  never prices, totals, or a "payment succeeded" flag.
- **Only the signed Razorpay webhook marks an order paid** (ADR-0002). The
  browser callback is UX only.
- **Never call WhatsApp or Razorpay from the order/webhook request path.** The
  requirement is persisted as an Outbox Job inside the business transaction
  (ADR-0006) and sent by the worker afterwards. A provider outage must not be
  able to fail an order. The one exception is `createRazorpayOrder`, which must
  run AFTER the order transaction commits, never inside it (ADR-0008).
- **A failed Razorpay start keeps the order** (ADR-0008). The order exists and
  holds stock, so the failure response carries the order and its access token so
  the customer can retry. Never delete the order and never return a bare failure.
- **Alerts fire at different moments per payment method.** COD queues the owner
  alert at creation; Razorpay queues it from the webhook on capture, so an
  abandoned checkout does not page the shop. The outbox's unique
  `(order_id, type)` makes it once-per-order either way.
- **The webhook must read the RAW body** (`await request.text()`), never
  `request.json()`. The signature covers the exact bytes; re-serializing changes
  them and the digest stops matching.
- **Products are disabled, never deleted.** Order items hold a foreign key to the
  product and a snapshot of its name/price (CONTEXT.md "Active"). A delete would
  orphan order history. There is deliberately no `deleteProduct`.
- **Admin stock edits are absolute, order stock changes are guarded increments**
  (ADR-0009). Different operations, deliberately different functions: an
  increment cannot correct a wrong count, only compound it.
- **The sweep only cancels an order that is still unpaid and still uncancelled**,
  via a guarded update, so a payment landing at the same instant wins. Never
  restock an order that is `PAID`.
- **Never refund automatically.** A refund is an explicit admin action whose
  eligibility is re-verified server-side from the database (ADR-0011). Never
  retry a refund whose outcome is uncertain — reconcile with the provider first.
  A timeout may mean the money already moved.
- **Admin product edits are guarded on `version`** (ADR-0012). A stale save is
  refused, never forced. The customer purchase path bumps the version too, so a
  sale cannot be silently overwritten.
- **Rate limiting falls back to in-memory**, which is per-instance. Check the
  startup log for which backend is active; a production deploy should say
  "distributed backend active".
- **Deployment splits two connection strings** (see `DEPLOYMENT.md` and
  `prisma.config.ts`): the app uses `DATABASE_URL` (Supabase transaction pooler,
  :6543) and the Prisma CLI uses `DIRECT_URL` (session/direct, :5432). A
  transaction-mode pooler cannot run migrations. `npm run build` runs
  `prisma generate` first, because Vercel starts from a clean checkout.
- **Idempotency belongs in the database, not in application logic.** Payment
  events use `INSERT ... ON CONFLICT DO NOTHING RETURNING` against the unique
  `(provider, provider_event_id)` index. A `try { insert } catch { ... }` cannot
  work: a unique violation ABORTS the Postgres transaction, so every following
  statement in it fails.
- **The database session is UTC** (ADR-0007), set in `src/lib/db/connection.ts`.
  Never pass a JS `Date` to `$queryRaw`; compute timestamps in SQL from integers.
  Getting this wrong shifts instants by the server's offset and lets a worker
  lease look expired, which causes duplicate sends.
- **`lib/db`, `lib/env`, `lib/logger` are `server-only`.** Importing them from a
  Client Component must stay a build error.
- **Routes do transport only.** Business rules go in `lib/<domain>/service.ts`;
  the domain is the only code that touches Prisma.
- **Migrations are serial.** Never author or edit migrations in parallel with
  another task.

## Verifying a change

```bash
nvm use
npm run typecheck && npm run lint && npm test && npm run build
```

Two checks need the real world and are **not** in `npm test` (which must stay
database-free). Run them when touching orders, pricing, the cart or admin:

```bash
npm run check:oversell              # Postgres: concurrency defence for stock
npm run check:e2e                   # Postgres + dev server: real-browser checkout
npm run check:admin                 # Postgres + dev server: auth + status machine
npm run check:admin-browser         # Postgres + dev server: real-browser admin flow
npm run check:outbox                # Postgres: notification durability + crash recovery
npm run check:webhook-idempotency   # Postgres: concurrent duplicate delivery (DB layer)
npm run check:webhook-route         # dev server: the webhook route over HTTP, real signatures
npm run check:sweep                 # Postgres: abandoned-order sweep never harms a paid order
npm run check:products              # Postgres: product admin service layer
npm run check:products-browser      # dev server: product admin in a real browser
npm run check:orders                # Postgres: order creation, both payment paths
npm run check:refunds               # Postgres: refund eligibility, idempotency, uncertainty
npm run check:database              # the deploy gate: UTC, migrations, constraints on DATABASE_URL
```

**Testing a browser check is itself fiddly.** The harnesses drive Chrome over
CDP; two traps have already cost real time and are worth remembering:

- A click only works after React hydrates. Clicking immediately after navigating
  is a no-op, so the checks click, verify the effect, and retry — but a retry
  must not blindly click again when the button toggles state (a second
  `Disable product` click *re-enables* it).
- Selector ambiguity is the usual cause of a confusing failure.
  `document.querySelector("form")` matches the header's sign-out form, and
  `[name="description"]` matches the document's `<meta>` tag. Scope to the form
  that contains the fields you care about.

**A `loading.tsx` can silently break `notFound()`.** A loading file creates a
Suspense boundary, so Next streams the response and commits a **200** before the
page's `notFound()` runs — the visitor gets a soft 404 with a 200 status. The
fix is structural: keep loading boundaries off any route that can call
`notFound()`. The catalogue's skeleton lives in `src/app/products/(list)/` while
`products/[slug]/` has none, which is why a disabled product still returns 404.
If you add a `loading.tsx`, check that every `notFound()` beneath it still
returns 404 — `curl -o /dev/null -w '%{http_code}'`.

"It compiles" is not verification. Demonstrate the behaviour (a curl, a page, a
query) and say what you observed.

## Admin security rules

- **Guard inside every page and action, never only in the layout.** Next 16's
  docs are explicit that a matcher or layout change can silently remove
  protection. Every admin page calls `requireAdmin()`; every admin server action
  calls `assertAdmin()`. A `proxy.ts` may be added for a fast redirect, but it is
  a convenience on top of the real gate.
- **Server actions are individually addressable endpoints.** An action that
  trusts "the page was behind a login" is callable by anyone who knows its id.
- **`middleware.ts` is deprecated in Next 16** — it is `proxy.ts` with a
  `proxy()` export.

## Machine notes

- Node 24 is required (Prisma 7 rejects Node 21). `.nvmrc` pins it.
- PostgreSQL runs from **miniconda**, not Homebrew, because `/opt/homebrew` is
  owned by another user. Start it with `docs/PROCESS.md`'s one-liner; data lives
  in `~/.local/share/pgdata/gotham`.
- After changing `prisma/schema.prisma`: `npx prisma migrate dev --name <x>`,
  then `npx prisma generate` (Prisma 7 does not run generate automatically).
