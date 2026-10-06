# Gotham Renewal

**Gotham Renewal** is the project. The shop it serves is **Adambakkam Sri
Srinivasa Boli Stall**, a family-run sweet stall in Adambakkam, Chennai. The
project name is deliberately separate from the business name, and the business's
display name lives in exactly one place (`src/lib/site.ts`).

The stall sells boli, savouries and sweets, by piece and by weight. Customers
browse a product catalogue, add items to a cart, and place an order paid by cash
on delivery or online. The business fulfils the order and keeps a WhatsApp alert
for every new order.

This file is the project's **glossary**. It defines what our words mean, so the
code, the database and the conversation all agree. It is not a spec and holds
no implementation detail.

## Catalogue

**Product**:
A sellable item with a name, a price, and a stock count. Products are the only
things a customer can add to a cart.
_Avoid_: Item, SKU, article

**Slug**:
The human-readable, unique, URL-safe identifier for a Product, used in
`/products/[slug]`. A slug may not change once published, because it is the
public address of the product.
_Avoid_: URL, permalink, handle

**Stock**:
How many units of a Product the business can currently sell. A Product with
zero stock cannot be ordered.
_Avoid_: Inventory, quantity, count

**Active**:
A Product is *active* when it is visible in the catalogue and orderable.
Inactive products are hidden ("disabled") but never deleted, so that historical
orders that reference them remain intact.
_Avoid_: Enabled, published, live

**Price**:
The amount of money charged for one unit of a Product, in paise.
_Avoid_: Rate, cost, MRP

## Ordering

**Order**:
A customer's committed request to buy one or more Products, with a delivery
address and a chosen payment method. Once placed, an Order's money amounts are
frozen and never recomputed.
_Avoid_: Purchase, transaction, sale

**Order Number**:
The short, unique, human-facing identifier of an Order, shown to the customer
and quoted on WhatsApp (e.g. `GR-1042`). Distinct from the Order's internal id.
The `GR` prefix is a deliberate quirk: it stands for Gotham Renewal, the
project, not the shop. Changing it would rewrite the format on every existing
confirmation.
_Avoid_: Reference, receipt number

**Placing an Order**:
The single server-side act of turning a Cart into an Order: reading prices from
the database, reserving Stock, allocating an Order Number, and writing the Order
with its Order Items — all in one transaction. Only the server may do it.
_Avoid_: Checkout (that is the page, not the act), submit

**Order Item**:
One Product within an Order, recording the quantity bought and a **snapshot**
of the Product's name and unit price at the moment of purchase.
_Avoid_: Line item, cart line

**Snapshot**:
The copy of a Product's name and price stored on an Order Item. It exists so a
historical Order never changes when the Product is later renamed or repriced.
_Avoid_: Denormalisation, freeze

**Subtotal**:
The sum of all Order Item line totals, before shipping.
_Avoid_: Cart total, items total

**Shipping**:
The delivery charge added to a Subtotal to reach the Total. Computed by the
server.
_Avoid_: Delivery fee, postage, freight

**Total**:
The amount the customer owes: Subtotal plus Shipping. Always computed by the
server, never accepted from the browser.
_Avoid_: Grand total, amount payable

## Payment

**Payment Method**:
How the customer intends to pay: **Cash on Delivery** or **Razorpay**.
_Avoid_: Payment type

**Cash on Delivery (COD)**:
The customer pays in cash when the order arrives. No money changes hands
online, so a COD order is never `PAID` — its payment status is `COD`.
_Avoid_: Pay on delivery, collect

**Cart**:
A customer's unfinished, uncommitted selection of Products, held in their own
browser. It is not an Order and is never stored on the server. Its prices are a
display convenience and are discarded at checkout.
_Avoid_: Basket, bag

**Reservation**:
The act of reducing a Product's Stock when an Order is created, so the units are
held for that Order. A reservation happens before payment, for both payment
methods. An abandoned Order's Reservation is released by the Sweep.
_Avoid_: Hold, lock, allocate

**Sweep**:
The scheduled act of abandoning unpaid online Orders that are too old to still
be in progress, returning their reserved Stock. It never touches a paid Order or
a COD Order.
_Avoid_: Cleanup, expiry, garbage collection

**Abandoned Order**:
An online Order whose payment never arrived and which the Sweep has cancelled. A
Late Payment on an Abandoned Order leaves it `CANCELLED` and `PAID`, a state a
person must refund.
_Avoid_: Expired order, dead order

**Last Write Wins**:
The rule for an admin editing Stock: the value the admin submits is authoritative
and overwrites whatever is stored. Contrasted with the order path, which reserves
by increments under a guard.
_Avoid_: Merge, conflict resolution

**Gap-free numbering**:
Order Numbers are consecutive with no gaps (`GR-1042`, `GR-1043`). Chosen so the
business can trust the sequence; it costs a brief lock on a counter row per order.
_Avoid_: Sequential id

**Razorpay**:
The online payment provider. We create a Razorpay Order, the customer pays in
Razorpay's own interface, and Razorpay tells us the outcome by webhook.
_Avoid_: Gateway, PSP, payment processor

**Payment Status**:
Whether money has been received for an Order: `PENDING`, `PAID`, `COD`,
`FAILED` or `REFUNDED`.
_Avoid_: Payment state

**Payment Event**:
A record that we have received and processed one notification (webhook) from a
payment provider. Stored so the same notification can never be processed twice.
_Avoid_: Webhook log, callback

**Razorpay Order ID**:
The identifier Razorpay assigns to its own order, created by our server before
the customer pays. Stored on our Order.
_Avoid_: Razorpay reference

**Awaiting Payment**:
The state of an online Order whose payment the bank has not yet confirmed. Not a
failure: the webhook has not arrived, and it may still. The customer is told the
truth rather than shown a bare "pending".
_Avoid_: Unpaid, failed

**Settlement**:
The moment a verified webhook says an online payment has arrived, moving the
Order to `PAID`. Only a Settlement may set `PAID`; a browser callback cannot.
_Avoid_: Confirmation, success

**Razorpay Payment ID**:
The identifier Razorpay assigns to the actual payment, arriving on the webhook.
Stored on our Order once payment is confirmed.
_Avoid_: Transaction id

## Fulfilment

**Order Status**:
How far the Order has progressed through fulfilment: `NEW`, `CONFIRMED`,
`PACKED`, `SHIPPED`, `DELIVERED` or `CANCELLED`.
_Avoid_: Fulfilment state, order state

**Confirmed**:
The business has accepted the Order and intends to fulfil it. Distinct from
`PAID`: an order can be Confirmed while still awaiting cash on delivery.
_Avoid_: Accepted, approved

**Cancelled**:
The Order will not be fulfilled. Stock is returned. Cancellation is terminal —
a Cancelled Order never moves again.
_Avoid_: Void, declined, dropped

**Transition**:
A permitted move from one Order Status to the next. Orders advance one step at a
time; skipping a step and un-cancelling are both refused.
_Avoid_: Status change, update

## Administration

**Admin**:
The shop owner. The only person who may see customer details or change an Order.
There is one, and they are not a Customer.
_Avoid_: User, staff, operator

**Session**:
Proof that the Admin is signed in, carried in a signed cookie. It expires after
twelve hours, and rotating the signing secret ends every Session at once.
_Avoid_: Login, token

## Notification**Notification**:
A message we attempted to send over an external channel (currently WhatsApp),
with its own delivery outcome: `PENDING`, `SENT` or `FAILED`.
_Avoid_: Alert, message, ping

**Order Alert**:
The Notification sent to the **business's own** WhatsApp number when an Order is
placed. Its purpose is to tell the owner to act, not to inform the customer.
_Avoid_: Admin notification, order email

## Delivery guarantees

**Outbox**:
The `notifications` table, holding durable jobs. A job is written in the same
transaction as the Order, so "the Order exists" and "an alert is owed" are one
atomic fact. Alerts are sent later, never in the request path.
_Avoid_: Queue, message bus

**Job**:
One row in the Outbox: a Notification that must be sent. It has a status, an
attempt count, and a time it next becomes eligible.
_Avoid_: Task, message, event

**Lease**:
The time a worker holds a Job while sending it. The lease lets a Worker that
dies be recovered: once it lapses another run may claim the Job, and while it is
live no other Worker may.
_Avoid_: Lock, reservation

**At-least-once**:
The delivery guarantee for Notifications. A crash between sending and recording
success can resend, so a duplicate alert is possible; a lost alert is not. The
provider has no idempotency key, so this is a deliberate choice, not an
oversight.
_Avoid_: Exactly-once

**Idempotency**:
Processing a duplicate webhook delivery at most once, enforced by a database
unique constraint on `(provider, providerEventId)` rather than by application
logic. The second delivery is accepted and ignored, not treated as an error.
_Avoid_: Deduplication

**Refund**:
An attempt to return captured money to the customer through the payment
provider. One row per attempt, never overwritten, and never issued automatically
— an Admin decides, the server verifies, the provider moves the money.
_Avoid_: Reversal, credit, return

**Refund Required**:
An Order that is Cancelled while holding the customer's money (CANCELLED + PAID).
The shop owes a refund. A person must act; the app will not.
_Avoid_: Refundable, owed

**Reconcile**:
Asking the payment provider what actually became of a Refund attempt whose
outcome is unknown. The only safe way out of the Uncertain state — never a blind
retry.
_Avoid_: Retry, resubmit

**Stale Edit**:
An Admin saving a change based on values that have since moved — another Admin
edited, or a sale landed. Refused rather than applied, so nothing newer is
silently overwritten.
_Avoid_: Conflict, collision

**Access Token**:
A signed, expiring token that authorises viewing one Order's confirmation page.
Required because an Order's id is not a secret: it appears in browser history,
`Referer` headers and server logs.
_Avoid_: Order link, session

**Customer Notification**:
A Notification sent to the **customer's** WhatsApp number about their Order's
progress. Designed for but not sent in the initial build.
_Avoid_: Order update, shipping update
