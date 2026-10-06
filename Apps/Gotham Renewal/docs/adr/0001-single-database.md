# 0001: One PostgreSQL database for all business entities

**Status:** accepted

## Context

The application has five persistent entities: products, orders, order items,
payment events, and notifications. Images are binary blobs that need a CDN. A
payment provider (Razorpay) holds payment state.

Placing an order touches an order, its items, and a stock decrement that must
either all succeed or all roll back. Prisma can wrap those in one transaction
only if they live in the same database.

## Decision

All five entities live in a single PostgreSQL database. Images go to object
storage (Supabase Storage) referenced by URL. Razorpay's own ledger is not
mirrored — we store only the ids and one payment-event row per webhook.

## Considered options

- **Separate stores per domain** — rejected. It converts "place an order" into a
  distributed transaction requiring an outbox, sagas, and reconciliation. That
  is a large amount of machinery to buy nothing at this volume.
- **Storing images as `bytea` in Postgres** — rejected. It bloats the database
  and its backups, and every image read occupies a database connection.

## Consequences

- Postgres is a single scaling axis. Read replicas and partitioning come before
  a second datastore.
- The transaction boundary is a real boundary: anything that must be atomic with
  an order has to be in this database. WhatsApp notifications are deliberately
  exempt (see ADR-0003).
