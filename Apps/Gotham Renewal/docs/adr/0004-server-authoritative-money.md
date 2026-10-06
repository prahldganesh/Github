# 0004: The browser sends ids and quantities; the server computes all money

**Status:** accepted

## Context

An order form must send *something* to the server. The obvious design sends the
cart contents — including the prices the customer saw and the total to charge.
That is also the design that lets anyone edit the request and buy a ₹9,999 item
for one paisa, or set their own `paymentStatus: "PAID"`.

## Decision

The order request carries **product ids, quantities and delivery details only**.
There is no `price`, `subtotal`, `total`, `paymentStatus` or `orderStatus` field
in the validation schema, so an injected one is stripped before it reaches any
code. Every rupee is read from the `products` table by the server and computed by
`priceOrder`, a pure function with its own tests.

Consequences that follow from this single rule:

- Prices are read at *order time*, not cart time. If a price changed while the
  customer was shopping, the server's price wins. The client's displayed total is
  a preview and is never authoritative.
- Stock is checked against the authoritative `priceOrder` result, and the real
  guard is the atomic conditional decrement (ADR-0003), not the check.
- The confirmation page reads the order from the database by id. It never renders
  order details supplied through the URL, so a fabricated order cannot be shown.

## Considered options

- **Send the client's total and verify it server-side** — rejected. Verification
  that must agree with a client-computed number is a second implementation of the
  pricing rules, and the two will drift.
- **Send prices, and trust them for display only** — rejected. A field that is
  accepted is a field that can be misused; the safest field is the absent one.

## Consequences

- Adding a discount or a coupon means adding it to `priceOrder` **and** to the
  schema if the client must supply anything (a code, for instance). It can never
  mean trusting a client-supplied amount.
- The client and server can legitimately disagree on the total. The server is
  right, and the confirmation page is where the customer sees the truth.
