# 0003: Stock is decremented at order creation; notifications stay outside the transaction

**Status:** accepted

## Context

Two questions arise the moment an order can be paid online: when should stock be
reduced, and what happens if the confirmation WhatsApp message fails?

For stock, the risk is overselling: two customers buying the last unit at the
same time. For notifications, the risk is the opposite — a third-party outage
should not be able to fail a paid order.

## Decision

**Stock.** Decrement at order creation for both payment methods, inside the same
transaction that inserts the order, using a guarded update (`WHERE stock >= qty`)
so the database itself refuses to go negative. If the guard matches zero rows,
the order is rejected as out of stock. A Razorpay order that is never paid holds
its stock until it is cancelled or expires; this is deliberate, because the
alternative (decrement after payment) can sell stock the business no longer has
while a customer is mid-checkout.

**Notifications.** The WhatsApp alert is sent *after* the order transaction has
committed, in a separate step. A notification row is stored with
`PENDING`/`SENT`/`FAILED`, so a failure is recorded and retryable rather than
silently lost.

## Considered options

- **Reserve stock, commit after payment** — rejected as the default. It doubles
  the state machine and needs an expiry sweeper before the business sees any
  benefit at family-business volume.
- **Send WhatsApp inside the order transaction** — rejected outright. It would
  let an unreachable Meta API roll back a real, paid order.

## Consequences

- Unpaid Razorpay orders can hold stock. Cancelling an order must return stock;
  Phase 12 adds this, plus an optional sweep for stale pending orders.
- `notification.status = FAILED` is a normal, expected state that needs a retry
  path, not an alarm.
