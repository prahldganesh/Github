# 0008: A failed Razorpay start keeps the order; it does not fail the request

**Status:** accepted

## Context

Creating a Razorpay order needs two steps that cannot be one transaction: insert
the local order (a database write), then ask Razorpay for its order id (a network
call to a third party). Something has to give when the second step fails.

The tempting answer is to treat it as the whole request failing and return an
error. That is wrong, and expensively so: by then the local order EXISTS and a
unit of stock is RESERVED. A plain failure would leave an invisible order holding
stock that the shop cannot sell and the customer cannot see.

## Decision

The local order is committed **first**, as `PENDING` with its stock reserved.
Razorpay is then called **outside** that transaction. If the call fails:

- the order stays, `PENDING`, holding its stock;
- the response is `503` with a `razorpay-unavailable` code **and the order** -
  id, order number, and its access token - so the client can send the customer to
  the confirmation page, where they can try paying again;
- **no owner alert is queued.** An abandoned checkout must not page the shop.

For COD the alert IS queued at creation, because that order is complete and
actionable immediately. For Razorpay the alert is queued by the **webhook** on
capture. The unique `(order_id, type)` constraint on the outbox means the alert
can only ever fire once per order, whichever path created it.

## Considered options

- **Call Razorpay inside the order transaction** — rejected. It would hold row
  locks for the duration of a network round trip, and a timeout could not roll
  back cleanly. It also couples an order to a third party's latency.
- **Delete the order if Razorpay fails** — rejected. The provider call may have
  succeeded with the response lost in transit; deleting could destroy a real
  order. It also discards a reservation the customer is still entitled to.
- **Return a plain failure** — rejected. It strands reserved stock and hides the
  order from the person who placed it.
- **Queue the alert at creation for both methods** — rejected. The shop would be
  alerted about every abandoned checkout, which trains the owner to ignore the
  alerts.

## Consequences

- `CreateOrderResult`'s failure variant may carry an `order`. Callers must not
  read a missing `order` as "nothing happened" - that is why the field exists.
- Stale unpaid orders accumulate and hold stock. Phase 12's sweep is the answer:
  cancel orders stuck `PENDING` past a threshold, which the existing
  `shouldRestock` logic already returns stock for.
- A webhook can arrive for an order whose Razorpay id was never attached only if
  the response was lost after Razorpay created it; the webhook handler logs and
  ignores an unmatched order rather than guessing.
