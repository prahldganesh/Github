# Gotham Renewal

**Gotham Renewal** is the project's name. The business it runs is **Adambakkam
Sri Srinivasa Boli Stall** — a family-run sweet stall in Adambakkam, Chennai.
The two names are deliberately separate: the shop's name is display data, held
in one place (`src/lib/site.ts`), and never hardcoded into pages.

A small e-commerce storefront: product catalogue, cart, checkout with
cash-on-delivery or Razorpay, an admin order dashboard, and WhatsApp order
alerts. Built as a modular monolith on Next.js + PostgreSQL.

**Status: code-complete (phases 1-16), database verified against Supabase
(Mumbai).** Not yet staging- or production-verified — see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §12 and
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for exactly what that means.

---

## Stack

| Concern | Choice |
|---|---|
| Framework | Next.js 16 (App Router, Server Components) + React 19 |
| Language | TypeScript, `strict` |
| Styling | Tailwind CSS 4 |
| Database | PostgreSQL (Supabase in production) |
| Query layer | Prisma 7 (with the `@prisma/adapter-pg` driver adapter) |
| Validation | Zod 4 |
| Payments | Razorpay (Phase 10+) |
| Notifications | WhatsApp Cloud API (Phase 9+) |
| Hosting | Vercel (Phase 14) |

## Requirements

- **Node.js 24 LTS** (`nvm use` reads [.nvmrc](.nvmrc)). Prisma 7 rejects Node 21,
  and Node 21 is end-of-life anyway.
- **PostgreSQL 17**. On this machine it runs from **miniconda**, not Homebrew —
  `/opt/homebrew` is owned by another user, so `brew install` fails without
  sudo. Both paths are documented below.
- npm 11+ (ships with Node 24).

## First-time setup

### 1. Use the right Node

```bash
nvm install 24
nvm use
node -v   # expect v24.x
```

### 2. Start PostgreSQL

**This machine (works without sudo):**

```bash
conda install -y postgresql            # provides psql, initdb, pg_ctl
export PATH="$HOME/miniconda3/bin:$PATH"

# First time only — create the data directory:
initdb -D ~/.local/share/pgdata/gotham -U postgres \
  --auth-local=trust --auth-host=trust -E UTF8

# Start the server:
pg_ctl -D ~/.local/share/pgdata/gotham \
  -l ~/.local/share/pgdata/gotham/server.log start
pg_isready -h 127.0.0.1 -p 5432        # expect "accepting connections"
```

**Alternative, Homebrew** (requires the one-time `sudo chown` below):

```bash
brew install postgresql@17
brew services start postgresql@17
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
```

> **Homebrew permission note.** On this machine `/opt/homebrew` is owned by
> another user (`Karthik`), so `brew install` fails with "not writable by your
> user". One-time fix: `sudo chown -R $(whoami) /opt/homebrew`. The conda path
> above avoids this entirely.

### 3. Create the database

```bash
npm run db:setup        # runs scripts/setup-db.sh (idempotent)
```

Creates the `gotham` role and the `gotham_renewal` database if they do not
exist. Safe to run repeatedly.

### 4. Configure the environment

```bash
cp .env.example .env
```

Then fill in `.env`:

- `DATABASE_URL` — already correct for the local database created above.
- `ADMIN_SESSION_SECRET` — generate one:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- `ADMIN_PASSWORD` — any long random string for now.
- Leave the Razorpay and WhatsApp groups **empty** for Phase 1. The app starts
  without them; these features are wired in later phases.

`.env` is gitignored. Never put a secret in a `NEXT_PUBLIC_*` variable — that
prefix means "inline this into the browser bundle".

### 5. Install, generate, migrate, run

```bash
npm install
npm run db:generate     # generate the Prisma client into ./generated
npm run db:migrate      # apply migrations and create the enums
npm run dev             # http://localhost:3000
```

## Verifying Phase 1

1. **Database reachable:**
   ```bash
   curl -s localhost:3000/api/health | jq
   # { "status": "ok", "database": "up", "latencyMs": 1 }
   ```
2. **Home page** at <http://localhost:3000> shows "connected" on the Database row.
   If it shows "unreachable", Postgres is not running — the app itself is fine.
3. **Enums exist in the database:**
   ```bash
   export PATH="$HOME/miniconda3/bin:$PATH"
   psql "postgresql://gotham:gotham@127.0.0.1:5432/gotham_renewal" \
     -c "SELECT typname FROM pg_type WHERE typtype='e' ORDER BY typname"
   ```
4. **Types, lint and tests are clean:**
   ```bash
   npm run typecheck && npm run lint && npm test
   ```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` / `start` | Production build and server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run db:setup` | Create the local role and database (idempotent) |
| `npm run db:generate` | Generate the Prisma client |
| `npm run db:migrate` | Create + apply a migration in development |
| `npm run db:deploy` | Apply committed migrations (production) |
| `npm run db:studio` | Prisma Studio, a GUI over the database |

## Project layout

```
src/
  app/
    layout.tsx              root layout (Server Component)
    page.tsx                Phase 1 checkpoint page
    api/health/route.ts     database liveness probe
  lib/
    db/index.ts             Prisma client singleton (server-only)
    env.ts                  env validation, fails fast (server-only)
    health.ts               connectivity check
    logger.ts               structured JSON logging (server-only)
    money.ts                paise helpers
    site.ts                 non-secret display config
prisma/
  schema.prisma             enums now; Product/Order tables in later phases
  migrations/               generated migration history (committed)
prisma.config.ts            Prisma 7 config (holds the datasource URL)
generated/prisma/           generated client (gitignored)
docs/
  ARCHITECTURE.md           system shape and request flows
  PROCESS.md                build order, parallelisation rules, machine notes
  adr/                      decision records
  research/                 primary-source research for integrations
CONTEXT.md                  domain glossary (the project's vocabulary)
```

The full folder plan for the finished app — `lib/orders`, `lib/payments`,
`lib/whatsapp`, and the route structure — is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Conventions

- **Money is integer paise.** Never a float number of rupees. See `src/lib/money.ts`.
- **The server is authoritative.** The client sends product ids and quantities,
  never prices or totals.
- **Server modules are marked `server-only`**, so a Client Component importing
  them fails the build rather than leaking secrets.
- **Routes do transport only**; business rules live in `lib/<domain>/service.ts`.
- **Secret configuration goes through `src/lib/env.ts`**, which validates at
  startup and refuses to run on a partially configured provider.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Invalid environment configuration` on boot | A required `.env` value is missing. The error lists every problem at once. |
| `/api/health` returns 503 | Postgres is not running: `brew services start postgresql@17`. |
| `Cannot find module '@/generated/prisma/client'` | Run `npm run db:generate`. |
| `Prisma only supports Node.js versions…` | You are on Node 21. `nvm use`. |
| `brew install` says "not writable by your user" | The `sudo chown` step above. |
| Tables/enums missing | `npm run db:migrate`. |
