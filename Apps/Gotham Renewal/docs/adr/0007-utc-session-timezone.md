# 0007: The database session runs in UTC

**Status:** accepted

## Context

All timestamp columns are `timestamptz`, which is the correct type for an
instant. That should have been enough. It was not.

`pg` serializes a JS `Date` parameter using its **local** representation, with no
offset, and Postgres then interprets that naive string in the **session**
timezone. This machine's server timezone is `Asia/Kolkata` (+05:30). So:

```
new Date("2026-06-01T09:20:55Z")   ->   stored as 2026-06-01T03:50:55Z
```

The instant moved 5.5 hours into the past — and **reading it back through the
same adapter returned the original value**, so a round-trip test passed. The
corruption was only visible by asking Postgres directly.

It was not cosmetic. Three real consequences:

1. A retry scheduled an hour ahead landed in the past, so backoff fired
   immediately instead of waiting.
2. A worker lease 60 seconds in the future looked already expired. A second
   worker could claim the same job and **send the customer a duplicate
   WhatsApp message**.
3. Every `created_at` and `updated_at` was 5.5 hours off.

## Decision

Set `options=-c timezone=UTC` on the connection string, in one place
(`src/lib/db/connection.ts`), used by the app client, the CLI checks and the
seed. The session runs in UTC, so a naive local string and a UTC instant agree.

Also: **do not pass JS `Date` objects as parameters to `$queryRaw`.** Compute
timestamps in SQL from integers instead:

```sql
locked_at = now() + ($1::int * interval '1 millisecond')
```

An integer cannot be reinterpreted in a different timezone.

## Consequences

- Timestamps are consistent regardless of the machine's locale. A developer in
  another timezone, or a CI runner on UTC, produces identical data.
- Supabase's pooler already defaults to UTC, so in production this is
  belt-and-braces; locally it is load-bearing.
- `npm run check:outbox` asserts a live lease is not stolen. That check is what
  caught this bug, and it must keep running against a real database — the
  round-trip through the ORM alone would not have revealed it.
