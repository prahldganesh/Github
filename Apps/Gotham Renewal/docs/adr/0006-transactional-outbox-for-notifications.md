# 0006: Notifications are an outbox; the request never waits on WhatsApp

**Status:** accepted

## Context

When an order is placed, the business owner must be told. The obvious
implementation calls the WhatsApp Cloud API inside the request that creates the
order. That couples an order to a third party's uptime:

- a slow Meta response delays the customer's checkout;
- a Meta outage fails an order the shop could have fulfilled;
- a crash between "order committed" and "message sent" loses the alert with no
  record it was ever owed;
- there is no way to see what failed or to retry it.

## Decision

Use a **transactional outbox**. The `notifications` table holds durable jobs.

- The job row is inserted **inside the same transaction** that creates the
  order, so "the order exists" and "an alert is owed" are one atomic fact.
  Either both are true or neither is.
- The WhatsApp API is called **after the commit**, by a worker, never in the
  request or webhook path.
- The worker claims jobs with `FOR UPDATE SKIP LOCKED` and a **lease**
  (`locked_at`). A worker that dies mid-send leaves the lease to expire, and
  another run reclaims the job. Nothing is lost to a crash.
- Failures are classified. A retryable failure (timeout, rate limit) sets a
  future `next_attempt_at` with exponential backoff; a permanent one (bad token,
  unknown template) or exhausting `MAX_ATTEMPTS` marks the job `FAILED`, which
  means "a human must look".
- At-most-once is not achievable (the Cloud API has no idempotency key), so the
  trade is explicitly **at-least-once**: a crash after sending but before
  recording `SENT` may resend. A duplicate alert is preferable to a lost order.

## Considered options

- **Call WhatsApp in the request** — rejected. It makes an order's success
  depend on Meta, which is the failure this design exists to prevent.
- **A proper queue (Redis, SQS, RabbitMQ)** — rejected as premature. It adds
  infrastructure and a second source of truth; Postgres already provides the
  atomicity the outbox needs, and the volume is a family shop's orders.
  Revisit if the outbox table becomes a bottleneck, which it will not soon.
- **Fire-and-forget `after()` / `waitUntil()`** — rejected. It runs after the
  response but is not durable: a crash loses the alert, and nothing records that
  it was owed. That is the exact failure mode the durability check tests for.

## Consequences

- The notification layer is provider-agnostic: `notifications.payload` stores
  what to send, so a future SMS or email channel is a new `channel` value and a
  handler, not a schema change.
- Customer notifications (order confirmed/packed/shipped) drop in as new
  `NotificationType` values with a handler.
- The owner's alert may arrive a few seconds after checkout. That is the
  deliberate price of not coupling checkout to Meta.
