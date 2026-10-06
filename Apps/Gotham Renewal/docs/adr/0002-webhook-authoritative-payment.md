# 0002: Verified webhooks, not browser callbacks, settle payment

**Status:** accepted

## Context

Razorpay offers two signals when a payment finishes: a JavaScript callback in
the customer's browser, and a server-to-server webhook. The browser callback can
be spoofed by anyone who can open devtools or replay a request. The webhook can
be verified with a signature only we can produce.

## Decision

Only the signed Razorpay webhook may mark an order `PAID`. The browser callback
is used for user experience (progress the UI, show a confirmation) and never for
trust. Every webhook is signature-verified against the raw request body and
deduplicated on a unique `(provider, provider_event_id)` pair before any order
is modified.

The browser, similarly, never sends a price or a total. It sends product ids and
quantities; the server reads prices from the database and computes the total.

## Consequences

- A lost webhook leaves an order `PENDING`; it is recovered by retry or manual
  reconciliation rather than by trusting the client.
- Webhook handling must read the raw body (`await request.text()`), because
  re-serialising parsed JSON changes the bytes and invalidates the signature.
- Duplicate deliveries are normal and must return `200` without reprocessing.
