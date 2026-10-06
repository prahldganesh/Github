# 0005: Admin auth is a signed cookie, guarded in every page and action

**Status:** accepted

## Context

The admin area shows every customer's name, phone and address, and can change
order states. It needs authentication, and the choice of mechanism carries
long-term weight: it decides how revocation works and what a session costs.

The family business has one admin (a small number is possible later). Customers
never log in.

## Decision

**One admin password, verified server-side** against `ADMIN_PASSWORD` — either
plaintext for development or a scrypt hash (`npm run admin:hash`, the production
form). On success, the server sets a **signed** session cookie: an HMAC-SHA256
over `{sub, exp}` using `ADMIN_SESSION_SECRET`. The cookie is `HttpOnly`,
`SameSite=Lax`, and `Secure` in production.

**The guard lives inside every admin page and every admin server action** —
`requireAdmin()` / `assertAdmin()` — not only in the layout or a proxy. Next 16's
own documentation warns that "a matcher change or a refactor that moves a Server
Function to a different route can silently remove Proxy coverage", and server
actions are individually addressable POST endpoints. A gate that a config edit
can open is not a gate.

## Considered options

- **Supabase Auth** — rejected. It couples admin identity to Supabase and adds
  password resets, MFA and a user table for exactly one user. Revisit if the
  business grows several staff with different permissions.
- **A sessions table** — rejected for now. It would allow per-session revoke and
  "signed in devices", at the cost of a database read on every admin request and
  an expiry sweeper. Signed cookies have no such read. The trade is recorded: to
  revoke, rotate `ADMIN_SESSION_SECRET`, which signs everyone out.
- **Plaintext password forever** — allowed to bootstrap, but the README and
  `.env.example` direct production to the hash form, because an env var is
  readable by anyone who can see the environment.

## Consequences

- There is no "forgot password" and no per-session revocation. Both are
  deliberate for a single-admin store; ADR-0005 is the place to revisit.
- The session payload is signed, not encrypted, so it is **readable** by whoever
  holds the cookie. Nothing sensitive may be put in it — today it carries only a
  subject and an expiry.
- Rotating the secret is the revocation mechanism, and it is blunt: it logs
  every admin out at once.
