# Prisma Schema Patterns for a Small E-commerce App

Research notes for `gotham-renewal`: a Next.js 16 App Router + React 19 + TypeScript
(strict) modular monolith, PostgreSQL, Prisma ORM **7.10.0** with the mandatory
`@prisma/adapter-pg` driver adapter, Webhook-driven Razorpay payments, WhatsApp
notifications, and money stored as **integer paise**.

This document is written against Prisma 7 specifically. Prisma 7 differs from
Prisma 6 in ways that bite: **driver adapters are mandatory**, the datasource URL
lives in `prisma.config.ts` (not `schema.prisma`), `datasource.directUrl` was
removed, and `prisma migrate dev` **no longer auto-runs `prisma generate`**.

Primary sources are cited inline. Key ones:

- Data model / models: <https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/models>
- Config API: <https://www.prisma.io/docs/orm/v7/reference/prisma-config-reference>
- Transactions (v7): <https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions>
- Migration workflow (v7): <https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/development-and-production>
- Shadow database (v7): <https://www.prisma.io/docs/orm/v7/prisma-migrate/understanding-prisma-migrate/shadow-database>
- Supabase + Prisma: <https://supabase.com/docs/guides/database/prisma> and <https://www.prisma.io/docs/orm/v6/overview/databases/supabase>
- Prisma 7 upgrade notes (skills): <https://github.com/prisma/skills/blob/main/prisma-upgrade-v7/SKILL.md>

---

## 0. Prisma 7 project wiring (context for everything below)

The generator is `prisma-client` (not `prisma-client-js`) with an explicit
`output`, and the datasource has **no `url`** in the schema file. The URL is
supplied by `prisma.config.ts` for CLI commands, and by the driver adapter at
runtime.

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}
```

```ts
// prisma.config.ts
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations", seed: "tsx prisma/seed.ts" },
  datasource: { url: env("DIRECT_URL") }, // CLI + migrations use the direct URL
});
```

```ts
// src/lib/prisma.ts
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
export const prisma = new PrismaClient({ adapter });
```

> **Prisma 7 gotchas already visible here**
> - The driver adapter is **not optional** in Prisma 7 — `new PrismaClient({ adapter })`.
>   Install `@prisma/adapter-pg` **and** `pg`.
> - `datasource.directUrl` was **removed** in v7; give the CLI a direct URL by
>   pointing `datasource.url` at `DIRECT_URL` in `prisma.config.ts`
>   (<https://www.prisma.io/docs/orm/v7/reference/prisma-config-reference#datasourcedirecturl-removed>).
> - `env()` throws if the variable is missing **even for commands that don't need
>   a DB** (e.g. `prisma generate` in CI). Use `process.env.X!` if the URL may be
>   absent in some pipelines.

---

## 1. The domain tables

All money is `Int` paise. Never `Float`. `Decimal` is avoided deliberately (the
brief mandates integers; paise integers are exact and trivially serializable).

### Product

```prisma
model Product {
  id          String   @id @default(cuid())
  name        String
  slug        String   @unique
  description String?
  price       Int      // paise, e.g. 19900 = ₹199.00
  stock       Int      @default(0)
  image_url   String?
  active      Boolean  @default(true)
  created_at  DateTime @default(now())
  updated_at  DateTime @updatedAt

  order_items OrderItem[]

  @@index([active])
  @@map("products")
}
```

- `slug` unique → stable, human-readable URLs (`/products/red-enamel-1l`).
- `price` is the **current** price. Orders snapshot their own price (see OrderItem),
  so changing `price` never rewrites history.
- `active` soft-hides a product without deleting it (order history keeps its FK).
- `@@index([active])` supports the storefront's `active = true` listing. Do not
  index every column — low volume, clarity first.

### Order

```prisma
model Order {
  id                  String        @id @default(cuid())
  order_number        String        @unique // "GR-1042", see §6
  customer_name       String
  customer_phone      String
  customer_email      String?
  address             String
  city                String
  state               String
  pincode             String
  subtotal            Int           // paise
  shipping            Int           @default(0)
  total               Int           // paise, = subtotal + shipping
  payment_method      PaymentMethod
  payment_status      PaymentStatus @default(PENDING)
  order_status        OrderStatus   @default(NEW)
  razorpay_order_id   String?       @unique
  razorpay_payment_id String?       @unique
  created_at          DateTime      @default(now())
  updated_at          DateTime      @updatedAt

  items         OrderItem[]
  events        PaymentEvent[]
  notifications Notification[]

  @@index([order_status])
  @@index([payment_status])
  @@index([created_at])
  @@map("orders")
}
```

- `customer_email` is optional (family business often only has a phone).
- `pincode` is `String`, not `Int`: leading zeros are real, and it is never
  arithmetic.
- `razorpay_order_id` / `razorpay_payment_id` are `String? @unique`. The webhook
  handler looks orders up by ID, and uniqueness prevents double-attaching a
  payment to two orders.
- `cod` orders leave both Razorpay fields `null`.

### OrderItem (immutable purchase snapshot)

```prisma
model OrderItem {
  id           String @id @default(cuid())
  order_id     String
  product_id   String
  product_name String // SNAPSHOT: product name at purchase time
  quantity     Int
  unit_price   Int    // SNAPSHOT: price in paise at purchase time
  total        Int    // quantity * unit_price, in paise

  order   Order   @relation(fields: [order_id], references: [id], onDelete: Cascade)
  product Product @relation(fields: [product_id], references: [id], onDelete: Restrict)

  @@index([order_id])
  @@index([product_id])
  @@map("order_items")
}
```

- `product_name` and `unit_price` are **deliberately denormalized**. If the shop
  renames or reprices a product (or deletes it), the invoice must not change.
  Never read live product data to render a historical order — read these columns.
- `total` is stored (not computed) so a future rounding/shipping rule change
  cannot retrospectively alter an invoice.
- `onDelete: Restrict` on `product` means you cannot hard-delete a product that
  has ever been ordered; use `active = false` instead. This is the desired
  behaviour for a system of record.

### PaymentEvent (webhook log + idempotency)

```prisma
model PaymentEvent {
  id                String   @id @default(cuid())
  order_id          String
  provider          String   // "razorpay"
  provider_event_id String   // e.g. Razorpay's event id / payment id
  event_type        String   // "payment.captured", "payment.failed", ...
  processed_at      DateTime @default(now())

  order Order @relation(fields: [order_id], references: [id], onDelete: Cascade)

  @@unique([provider, provider_event_id])
  @@index([order_id])
  @@map("payment_events")
}
```

- `@@unique([provider, provider_event_id])` is the **webhook idempotency key**.
  Razorpay retries webhooks; the same event can arrive many times. Insert first;
  a `P2002` unique-violation means "already processed, return 200 and stop".
  Combined with a transaction, this makes handlers safely retryable.
- `provider` is a plain `String` (not an enum) so a second gateway later needs no
  migration; only two processors are realistically expected.

### Notification (WhatsApp / SMS / email outbox)

```prisma
model Notification {
  id                  String              @id @default(cuid())
  order_id            String?
  channel             NotificationChannel
  type                NotificationType
  recipient           String              // phone number or email
  status              NotificationStatus  @default(PENDING)
  attempted_at        DateTime?
  attempts            Int                 @default(0)
  last_error          String?
  provider_message_id String?             // e.g. WhatsApp message id
  created_at          DateTime            @default(now())
  updated_at          DateTime            @updatedAt

  order Order? @relation(fields: [order_id], references: [id], onDelete: SetNull)

  @@index([status])
  @@index([order_id])
  @@map("notifications")
}
```

- This is an **outbox**: a row is written `PENDING` in the same transaction as the
  business event; a worker (or a retry sweep) later sends and marks `SENT`/`FAILED`.
  This avoids the classic bug where the order commits but the message send throws.
- `attempted_at` (last attempt time) + `attempts` (count) + `last_error` support
  backoff and give the owner a visible failure reason.
- `provider_message_id` lets you reconcile with the WhatsApp provider later.
- `onDelete: SetNull` so order cleanup never destroys the notification audit trail.

---

## 2. Enums

Postgres enums are first-class in Prisma; use them for closed value sets that
appear in `WHERE` clauses and business logic. Use `String` only for
provider-supplied values (`event_type`, `provider`) where you cannot enumerate.

```prisma
enum OrderStatus {
  NEW
  CONFIRMED
  PACKED
  SHIPPED
  DELIVERED
  CANCELLED
}

enum PaymentStatus {
  PENDING
  PAID
  COD
  FAILED
  REFUNDED
}

enum PaymentMethod {
  COD
  RAZORPAY
}

enum NotificationStatus {
  PENDING
  SENT
  FAILED
}

enum NotificationChannel {
  WHATSAPP
  SMS
  EMAIL
}

enum NotificationType {
  ORDER_PLACED
  ORDER_CONFIRMED
  ORDER_PACKED
  ORDER_SHIPPED
  ORDER_DELIVERED
  ORDER_CANCELLED
  PAYMENT_RECEIVED
  PAYMENT_FAILED
}
```

Notes:

- Enum values sort in **declaration order**, and the generated client exports them
  as types (`OrderStatus.SHIPPED`), so status transitions are type-checked
  (<https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/models#defining-enums>).
- `PaymentStatus.COD` distinguishes "will be paid on delivery" from `PENDING`
  (awaiting an online payment). If you would rather not overload one enum, keep
  `PENDING` for online only and derive COD from `payment_method`; the brief lists
  `COD` as a `PaymentStatus`, so it is included here.
- Adding a value to a Postgres enum in a migration is a simple `ALTER TYPE ... ADD
  VALUE`; *removing/renaming* is not, so avoid speculative values.

---

## 3. Field types, IDs, and defaults

### ID strategy — recommendation: `cuid()` on all domain tables

| Option | Pros | Cons |
| --- | --- | --- |
| `Int @id @default(autoincrement())` | Small, fast, readable | Guessable/enumerable IDs in URLs and webhooks; leaks volume; harder to pre-generate IDs for batch transactions |
| `@default(uuid())` | Globally unique, standard | Long; not sortable; larger indexes |
| `@default(cuid())` | Unique, compact, roughly time-ordered, URL-safe, collision-resistant | Not a formal standard |

**Recommendation: `String @id @default(cuid())` for Product, Order, OrderItem,
PaymentEvent, Notification.** Justification for *this* app:

1. Order/customer records are exposed in URLs and webhook callbacks; sequential
   integers let anyone enumerate other customers' orders. CUIDs do not.
2. Pre-generating IDs lets you use nested writes or array transactions freely
   (independent writes) — see
   <https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions>.
3. Roughly time-sortable means recent rows cluster in the index, which helps the
   `created_at` listing queries.
4. Low volume, family business: the storage savings of `Int` are irrelevant; the
   enumeration risk is not.

Keep `order_number` (the human-facing `GR-1042`) separate from `id` (§6). Use
`Int @id @default(autoincrement())` **only** for a trivial join-free helper table
(e.g. a counter or a log you never expose) if you want.

> **Prisma 7 gotcha:** `@default(cuid())` (like `uuid()`) is generated **by Prisma
> Client, not the database**. Raw SQL inserts or another service will not get a
> value — the column has no DB default. If you need DB-side generation, use
> `String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid`.
> `@default(now())`, by contrast, *is* a real column default
> (<https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/models#now-vs-uuid-database-defaults-vs-generated-defaults>).

### `@db.VarChar(n)` vs `text`

- Prisma's default `String` maps to Postgres `text`, which is unconstrained and
  just as fast in Postgres — there is no performance reason to prefer `varchar(n)`.
- Use `@db.VarChar(n)` **only** when `n` is a genuine domain limit you want the
  database to enforce (e.g. `pincode @db.VarChar(10)`, `customer_phone
  @db.VarChar(20)`, `razorpay_payment_id @db.VarChar(64)`).
- Use plain `String` (→ `text`) for free-form fields: `description`, `address`,
  `last_error`, `event_type`.

**Recommendation:** plain `String` everywhere, with `@db.VarChar(n)` on
`pincode`, `customer_phone`, and provider IDs. Do not sprinkle `VarChar(255)` by
habit.

### Timestamps

```prisma
created_at DateTime @default(now())   // DB-side default, set on INSERT
updated_at DateTime @updatedAt        // Prisma-managed, set on every UPDATE
```

- `@default(now())` becomes a real Postgres column default (`DEFAULT CURRENT_TIMESTAMP`).
- `@updatedAt` is managed by Prisma Client (it injects the value on update); it is
  **not** a database trigger, so a raw SQL `UPDATE` will not refresh it. That is
  fine here because all writes go through Prisma.
- Keep `created_at` and `updated_at` on every table; the brief lists most of them.

---

## 4. Constraints and indexes — and why each exists

| Constraint / index | Table | Why |
| --- | --- | --- |
| `slug @unique` | Product | The slug is the public URL key; duplicates break routing and SEO. Uniqueness is enforced in the DB, not just app code, so a race between two admins cannot create two `red-enamel` rows. |
| `order_number @unique` | Order | The human reference (`GR-1042`) must be unambiguous for the owner and for manual reconciliation. Also the backstop that makes the §6 generator race-safe. |
| `@@unique([provider, provider_event_id])` | PaymentEvent | **Webhook idempotency.** Razorpay retries; this makes "have I already handled this event?" a database guarantee, not application logic. |
| `razorpay_order_id @unique`, `razorpay_payment_id @unique` | Order | Prevents a payment being attached to two orders and gives fast webhook lookup (`findUnique`). |
| `onDelete: Cascade` (Order → OrderItem, Order → PaymentEvent) | child tables | Deleting an order (rare, admin only) must not leave orphan line items or events. Cascade is safe because children have no independent life. |
| `onDelete: Restrict` (OrderItem → Product) | OrderItem | You must not hard-delete a product that appears in history; deactivate instead. Restrict makes that a DB-level invariant. |
| `onDelete: SetNull` (Notification → Order) | Notification | Notification history is an audit log and should survive order deletion. |
| `@@index([order_status])` | Order | Admin queue filters `WHERE order_status = 'NEW'` etc. |
| `@@index([payment_status])` | Order | Payment reconciliation: "find all PENDING/FAILED payments". |
| `@@index([created_at])` | Order | "Today's orders", dashboards, and ordering by recency. |
| `@@index([order_id])` | OrderItem, PaymentEvent, Notification | Relation lookups (`include: { items: true }`) hit this index. |
| `@@index([active])` | Product | Storefront listing filter. |

Foreign keys: every relation above declares `fields`/`references`, which Prisma
renders as a real `FOREIGN KEY` constraint. The default `onDelete` if omitted is
`Restrict` for required relations and `SetNull` for optional ones — this schema
states them **explicitly** so intent is readable
(<https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/relations>).

Composite unique constraint usage (for the webhook):

```prisma
@@unique([provider, provider_event_id])
```

generates the client key `provider_provider_event_id`, queryable with
`findUnique` / usable with `create` + catch `P2002`
(<https://www.prisma.io/docs/orm/v7/reference/prisma-schema-reference>).

---

## 5. Transactions: atomic, race-free stock decrement

### Concepts (Prisma 7)

- **Batch / array transaction** `prisma.$transaction([q1, q2])`: independent writes,
  all-or-nothing. Cannot pass generated IDs between statements.
- **Interactive transaction** `prisma.$transaction(async (tx) => { ... })`: use
  `tx` (not `prisma`) for every query so they share one connection and one
  transaction. Supports `isolationLevel`, `maxWait`, `timeout`.
  (<https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions>)

Rule of thumb from the docs: dependent logic → interactive; independent writes →
array; single write → no transaction (already atomic).

### The overselling problem

The naive "read stock, check, then update" is racy:

```ts
// WRONG under concurrency
const p = await tx.product.findUnique({ where: { id } });
if (p.stock < qty) throw new Error("Out of stock");
await tx.product.update({ where: { id }, data: { stock: p.stock - qty } });
```

Two checkouts can both read `stock = 1`, both pass the check, and both write — the
product oversells.

### Recommended fix: conditional `updateMany` guard

```ts
class OutOfStockError extends Error {
  constructor(public productId: string) {
    super(`Out of stock: ${productId}`);
  }
}

export async function placeOrder(input: PlaceOrderInput) {
  return prisma.$transaction(async (tx) => {
    // 1. Atomically decrement each product, guarded by stock >= qty.
    for (const item of input.items) {
      const res = await tx.product.updateMany({
        where: { id: item.product_id, active: true, stock: { gte: item.quantity } },
        data: { stock: { decrement: item.quantity } },
      });
      if (res.count === 0) throw new OutOfStockError(item.product_id);
    }

    // 2. Allocate the order number inside the same transaction (§6).
    const [row] = await tx.$queryRaw<{ value: number }[]>`
      UPDATE "counters" SET value = value + 1
      WHERE name = 'order'
      RETURNING value
    `;
    const order_number = `GR-${1000 + row.value}`;

    // 3. Create the order + snapshot line items.
    const order = await tx.order.create({
      data: {
        order_number,
        /* customer + address fields */
        subtotal: input.subtotal,
        shipping: input.shipping,
        total: input.total,
        payment_method: input.payment_method,
        items: {
          create: input.items.map((i) => ({
            product_id: i.product_id,
            product_name: i.product_name, // snapshot from the cart
            quantity: i.quantity,
            unit_price: i.unit_price,     // snapshot, paise
            total: i.quantity * i.unit_price,
          })),
        },
      },
    });

    // 4. Write the notification outbox rows (no I/O in here — just DB).
    await tx.notification.createMany({
      data: [
        {
          order_id: order.id,
          channel: NotificationChannel.WHATSAPP,
          type: NotificationType.ORDER_PLACED,
          recipient: input.customer_phone,
        },
      ],
    });

    return order;
  });
}
```

**Why this is safe.** `updateMany` with a `stock: { gte: quantity }` predicate
compiles to roughly:

```sql
UPDATE "products"
SET "stock" = "stock" - $1
WHERE "id" = $2 AND "active" = true AND "stock" >= $1;
```

Under Postgres' default `READ COMMITTED`, a concurrent `UPDATE` on the same row
blocks on the row lock; when the first transaction commits, the second
**re-evaluates the `WHERE` clause against the newly committed row** before
proceeding. If stock is now insufficient it matches zero rows → `count === 0` →
we throw → the whole transaction rolls back. No overselling, no explicit
`SELECT ... FOR UPDATE`, and no serializable-isolation retry loop needed for the
stock guard.

### When would you reach for `Serializable`?

Only if a single logical decision reads multiple rows and the decision must be
globally consistent (e.g. "total cart value across N products must stay under a
limit"), or if you replace the guarded update with read-then-write logic. Then:

```ts
await prisma.$transaction(
  async (tx) => { /* ... */ },
  { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5000, timeout: 10000 },
);
```

Serializable can abort with a write conflict (`P2034` on some setups, or a
`40001` serialization failure). Prisma does **not** retry for you — wrap the
transaction in a retry-on-conflict loop if you use it. For this app the guarded
`updateMany` is simpler and sufficient; prefer it.

### Transaction boundary (important)

- **Inside** the transaction: stock decrement, counter increment, order insert,
  order-item inserts, notification **row** insert, payment-event insert.
- **Outside** the transaction: Razorpay API calls, WhatsApp sends, emails, queue
  enqueues, file writes. Never call an external service inside the callback — the
  DB rolls back but the side effect does not. Create the outbox row inside, then
  perform the I/O after commit. This is the single most common transaction bug
  the Prisma docs call out
  (<https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions>).
- Keep transactions short: no `await fetch` and no slow work between the first and
  last statement.

### Webhook idempotency pattern

```ts
export async function handleWebhook(event: RazorpayEvent) {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.paymentEvent.create({
        data: {
          order_id: event.orderId,
          provider: "razorpay",
          provider_event_id: event.id,
          event_type: event.type,
        },
      });
      // ...update Order.payment_status / order_status...
    });
  } catch (e) {
    if (isUniqueViolation(e)) return; // already processed — return 200
    throw e;
  }
}
```

---

## 6. Race-safe order number generation (`GR-1042`)

Three options:

| Option | Race-safe? | Gaps? | Complexity |
| --- | --- | --- | --- |
| `COUNT(*) + 1000` | No | — | Least — avoid |
| Postgres sequence + `nextval` | Yes | Yes (rollbacks/nocache gaps) | Low, needs custom migration |
| **Counter table, atomic `UPDATE ... RETURNING`, inside the order transaction** | **Yes** | **No** | **Low** |

**Recommendation for this app: the counter table.** It is the simplest correct
option and gives gap-free, human-friendly numbers because the increment and the
order insert share one transaction — if the order rolls back, the number is
returned to the pool.

```prisma
model Counter {
  name  String @id
  value Int    @default(0)

  @@map("counters")
}
```

Seed once in a migration or seed script:

```sql
INSERT INTO "counters" ("name", "value") VALUES ('order', 0)
ON CONFLICT ("name") DO NOTHING;
```

Allocate (inside the order transaction, as shown in §5):

```ts
const [row] = await tx.$queryRaw<{ value: number }[]>`
  UPDATE "counters" SET value = value + 1
  WHERE name = 'order'
  RETURNING value
`;
const order_number = `GR-${1000 + row.value}`;
```

Why it is race-safe: the `UPDATE` takes a row-level lock on the single counter
row, so concurrent checkouts serialize on it for a few milliseconds and each gets
a distinct value. The `order_number @unique` constraint is the final backstop —
if a bug ever produced a duplicate, the insert fails rather than corrupting the
sequence.

Alternative (canonical Postgres): a native sequence created in a custom migration,

```sql
CREATE SEQUENCE order_number_seq START 1001;
```

```ts
const [{ nextval }] = await tx.$queryRaw<{ nextval: bigint }[]>`SELECT nextval('order_number_seq')`;
```

Sequences are lock-free and very fast, but **do not roll back** — a failed
checkout burns a number, so `GR-1042` may be followed by `GR-1044`. For a family
business that wants tidy consecutive invoices, prefer the counter table.

Do not use `prisma.order.count() + 1000`: two concurrent orders read the same
count and collide.

---

## 7. Migration workflow: dev vs production

### Development — `prisma migrate dev`

```bash
npx prisma migrate dev --name init
npx prisma generate   # REQUIRED in Prisma 7 — migrate dev no longer does this
```

`migrate dev`:

1. Reruns migration history in the **shadow database** to detect drift.
2. Generates a new migration from schema changes.
3. Applies pending migrations to your dev database.
4. (Prisma 6 also generated the client here; **Prisma 7 does not**.)

### Shadow database requirement

`migrate dev` creates and drops a temporary **shadow database** to detect drift
and to preview data loss. The database role in your datasource URL must therefore
be able to **create databases** — on Postgres it needs the `CREATEDB` privilege
(or superuser):

```sql
ALTER ROLE gotham_dev CREATEDB;
```

If you cannot create databases (common on hosted Postgres), create a dedicated
shadow DB and point the config at it:

```ts
// prisma.config.ts
datasource: {
  url: env("DIRECT_URL"),
  shadowDatabaseUrl: env("SHADOW_DATABASE_URL"),
},
```

The shadow database is **only** used in development. `migrate deploy` never uses
it, so production needs no shadow DB and no `CREATEDB`
(<https://www.prisma.io/docs/orm/v7/prisma-migrate/understanding-prisma-migrate/shadow-database>).

### Production — `prisma migrate deploy`

```bash
npx prisma migrate deploy   # in CI/CD, against the production direct URL
npx prisma generate         # run separately (deploy does not generate)
```

`migrate deploy` applies committed pending migrations, does **not** detect drift,
does **not** reset data, and does **not** generate the client. It should run in
the deploy pipeline, not from a laptop. Prisma Migrate also takes a Postgres
advisory lock so two concurrent deploys cannot race (10s timeout)
(<https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/development-and-production>).

Recommended `package.json` scripts:

```json
{
  "scripts": {
    "db:migrate": "prisma migrate dev",
    "db:deploy": "prisma migrate deploy",
    "db:generate": "prisma generate",
    "postinstall": "prisma generate"
  }
}
```

**Where `prisma generate` fits:** it turns `schema.prisma` into the typed client
at `generator.client.output`. Because Prisma 7 dropped the implicit run, make
generation explicit and deterministic: run it in `postinstall` and after every
`migrate dev`. In CI run it before `tsc`/`next build`, or TypeScript will not see
the generated types.

---

## 8. Connection pooling: local `@prisma/adapter-pg` and Supabase production

### Local development

Simplest possible: a direct connection to local Postgres, the pg adapter pooling
it for you.

```ts
// src/lib/prisma.ts
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
export const prisma = new PrismaClient({ adapter });
```

```dotenv
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/gotham?schema=public"
DIRECT_URL="postgresql://postgres:postgres@localhost:5432/gotham?schema=public"
```

`@prisma/adapter-pg` uses `node-postgres` (`pg`), which maintains its own
connection pool. Reuse a single `PrismaClient` instance across the app (Next.js
dev hot-reload can create many — cache it on `globalThis`).

### Supabase production

Supabase (Supavisor) offers three connection strings
(<https://supabase.com/docs/guides/database/prisma>):

1. **Direct** — `db.<ref>.supabase.co:5432` (IPv6-only on newer projects).
2. **Session pooler** — `...pooler.supabase.com:5432`.
3. **Transaction pooler** — `...pooler.supabase.com:6543`.

For serverless / auto-scaling (Vercel) runtime traffic, use the **transaction
pooler (port 6543)** and append `?pgbouncer=true`. For the Prisma CLI
(migrations, `db pull`, Studio), use a **direct or session** connection, because
migrations need a non-pooled, session-stable connection.

```dotenv
# Runtime (app queries) — transaction pooler
DATABASE_URL="postgres://prisma.<ref>:<pwd>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true"

# CLI (migrate, generate --sql) — session pooler / direct, port 5432
DIRECT_URL="postgres://prisma.<ref>:<pwd>@aws-0-<region>.pooler.supabase.com:5432/postgres"
```

```ts
// prisma.config.ts — CLI reads the direct URL
datasource: { url: env("DIRECT_URL") }
```

```ts
// runtime — adapter reads the pooled URL
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
```

**When is `directUrl` needed for migrations?** Whenever the runtime URL goes
through a pooler and the CLI needs a direct/session connection. In Prisma 6 you
expressed this with a separate `directUrl` field; **in Prisma 7 that field is
removed** — you achieve the same split by pointing `prisma.config.ts`
`datasource.url` at `DIRECT_URL` while the runtime adapter uses the pooled
`DATABASE_URL`.

**`prepare: false` / prepared-statement concerns.** A transaction-mode pooler
(such as Supavisor on 6543 or PgBouncer in transaction mode) reassigns the backend
connection between transactions, which breaks session-scoped server-side prepared
statements. The classic symptom is `prepared statement "s0" already exists`. The
`prepare: false` escape hatch originates with serverless drivers that *do* use
named prepared statements (e.g. Neon's `@prisma/adapter-neon`). With
`@prisma/adapter-pg` / `node-postgres`, normal queries use the simple/extended
query protocol without persistent named prepared statements, so `pgbouncer=true`
is generally enough — but if you hit that error, switch the runtime to the
**session pooler (5432)** or configure the pg adapter/pool to avoid prepared
statements. Keep the `?pgbouncer=true` parameter as Supabase's guide instructs.

**Other transaction-pooler caveats:** session state (advisory locks, temp tables,
`SET`) does not survive between transactions, and long queries can be terminated
by pooler timeouts. Migrations therefore must use the direct/session URL.

---

## Recommendations for this project

Concrete decisions, in priority order:

1. **IDs:** `String @id @default(cuid())` on Product, Order, OrderItem,
   PaymentEvent, Notification. Keep `order_number` as the separate human
   `GR-nnnn` reference. (CUIDs stop order enumeration and allow pre-generated IDs.)
2. **Money:** `Int` paise everywhere; store `OrderItem.unit_price` and
   `OrderItem.total` as immutable snapshots and never recompute historical
   invoices from live `Product` rows.
3. **Stock safety:** the conditional guarded update —

   ```ts
   const res = await tx.product.updateMany({
     where: { id, active: true, stock: { gte: qty } },
     data: { stock: { decrement: qty } },
   });
   if (res.count === 0) throw new OutOfStockError(id);
   ```

   No serializable isolation and no retry loop needed. Order insert, stock
   decrement, counter increment, and outbox rows all live in one interactive
   `prisma.$transaction`. External calls (Razorpay, WhatsApp) run **after** commit.
4. **Order numbers:** a `Counter` table row updated with atomic
   `UPDATE ... RETURNING` inside the order transaction; `order_number @unique` is
   the backstop. Gap-free and lock-simple. (Swap to a native sequence only if
   throughput ever matters more than tidy numbering.)
5. **Webhook idempotency:** `@@unique([provider, provider_event_id])` on
   PaymentEvent; insert-and-catch-`P2002` (or `skipDuplicates`). This is your
   replay protection.
6. **Notifications as an outbox:** rows are written inside the business
   transaction with `status = PENDING`; a worker sends and flips to `SENT`/`FAILED`
   using `attempts`, `attempted_at`, `last_error`, `provider_message_id`.
7. **Constraints:** unique `slug` and `order_number`; `Cascade` from Order to
   children; `Restrict` from OrderItem to Product (deactivate, never delete);
   indexes only on `order_status`, `payment_status`, `created_at`, `active`, and
   FK `order_id` columns.
8. **IDs/defaults gotcha:** remember `@default(cuid())`/`uuid()` are client-side
   only — raw SQL bypasses them. `@default(now())` is a true DB default.
9. **Operations:** dev uses `prisma migrate dev` (dev role needs `CREATEDB` for the
   shadow DB) **then** `prisma generate`; production uses `prisma migrate deploy`
   against `DIRECT_URL` **then** `prisma generate`. Put `prisma generate` in
   `postinstall` and in CI before the TypeScript build.
10. **Connections:** runtime `PrismaPg({ connectionString: DATABASE_URL })` using
    Supabase's transaction pooler (`:6543`, `?pgbouncer=true`); `prisma.config.ts`
    `datasource.url = env("DIRECT_URL")` (session pooler/direct `:5432`) for the CLI
    and migrations. Cache the client on `globalThis` in Next.js.

### Prisma 7 gotchas found

- Driver adapters are **mandatory**; `datasource.directUrl` is **removed** — split
  pooled vs direct by putting `DIRECT_URL` in `prisma.config.ts` and the pooled URL
  in the adapter.
- `prisma migrate dev` **does not run `prisma generate`** in v7. Generate
  explicitly, every time.
- `env()` in `prisma.config.ts` throws on a missing variable even for
  `prisma generate`; use `process.env.DATABASE_URL!` if the var may be absent in
  some pipelines.
- `@default(uuid())` / `@default(cuid())` are generated by Prisma Client, **not**
  the database; raw SQL gets no value unless you use `dbgenerated(...)`.
