# 0011: Refunds are an explicit, idempotent, admin-initiated workflow

**Status:** accepted

## Context

The sweep can cancel an unpaid order moments before its payment lands, and the
late webhook then leaves the order `CANCELLED` with `paymentStatus = PAID`. The
shop is holding money for an order it will not fulfil.

The obvious "fix" is to refund automatically whenever that state appears. That is
wrong for several reasons at once: the customer may have asked to keep the order
and pay another way; a partial refund may have been agreed; the payment may be
under dispute and must not be touched. An app that moves money on its own
inference is an app that will one day move money wrongly.

## Decision

Refunds are **explicit and admin-initiated**, with the server deciding whether
each one is legitimate.

- The app never refunds automatically. It *detects* the state, surfaces it on the
  dashboard, and waits for a person.
- Eligibility is verified **server-side from the database**, on every call: the
  order must be online, have a captured payment with a payment id, not already be
  refunded, and be cancelled. A hidden or absent button is a convenience, never
  the control.
- Refunds are **full-order only** for now. Partial refunds would need a reason
  and an amount agreed with the customer; the model does not pretend to support
  them.
- Every attempt is a durable row in `refunds` with its own status
  (`PENDING` / `PROCESSING` / `SUCCEEDED` / `FAILED`), attempt count, provider
  refund id and last error. History is never overwritten.

### Idempotency, in three independent layers

1. **Eligibility** refuses a refund for an order that is already `REFUNDED`.
2. **A unique `refunds.idempotency_key`** (`refund:<orderId>`), so concurrent
   clicks collide in Postgres and exactly one row is created. This is the same
   insert-first pattern the webhook uses, for the same reason: a check-then-act
   has a race.
3. **The provider**, which treats the refund `receipt` as an idempotency key. The
   same key is sent, so even a bypassed local guard cannot double-refund.

### Uncertainty is recorded, never guessed

A timeout or a 5xx means the refund **may exist**. That is not a failure, and it
must not be retried: a blind resubmit is the double-refund bug. The attempt stays
`PROCESSING`, and the only way out is `reconcileRefund`, which asks the provider
what actually happened - by id when we have one, otherwise by listing the
payment's refunds and matching our own. Only when the provider has no record is
the attempt marked `FAILED`, and only then does a retry become possible.

## Considered options

- **Automatic refund on CANCELLED + PAID** - rejected. It moves money on an
  inference, and the state is also reachable in situations where a refund is the
  wrong answer.
- **A boolean `refunded` on the order** - rejected. It cannot represent a failed
  attempt, a retry, or an uncertain outcome, and it loses the audit trail.
- **Refund from the browser via the SDK** - rejected outright. The key secret
  would reach the client, and payment state would originate there.
- **Retry on timeout** - rejected. It is the most likely way this system could
  double-refund someone.

## Consequences

- An operator must act on the dashboard. That is the intended cost.
- `PROCESSING` is a state a human must resolve, and the UI says so rather than
  offering a retry button that would be unsafe.
- Partial refunds, disputes and chargebacks are out of scope and recorded as
  such; the reconciliation path is where a future piece of work would extend
  this.
