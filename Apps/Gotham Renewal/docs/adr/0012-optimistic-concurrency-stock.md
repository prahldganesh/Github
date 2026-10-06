# 0012: Optimistic concurrency on product stock edits

**Status:** accepted

## Context

ADR-0009 chose absolute stock edits over increments, and explicitly recorded the
gap it left: an admin who loaded stock 10 and saved 8 would silently overwrite a
sale that landed in between. Last-write-wins.

That is not merely a two-admins problem. The customer purchase path writes stock
too. So the realistic failure is:

```
customer  buys the last unit          stock 10 -> 9
admin     (loaded stock 10) saves 8   stock  9 -> 8
```

The sale is erased and the shop's inventory is wrong by one - the same class of
bug as overselling, which the rest of the system works hard to prevent.

## Decision

Add a `version` column to `products`, bumped by **every** stock write, and make
admin edits conditional on it:

```sql
UPDATE products
SET    stock = $new, version = version + 1
WHERE  id = $id AND version = $expected
```

Zero rows updated means the read was stale. That is reported as `stale-edit` -
not retried, not forced through - and the admin is told the product changed and
must reload before saving.

The version is bumped by the **customer purchase path too** (`decrementStock`,
`incrementStock`). This is the part that makes the guard useful: if only admin
edits bumped it, an admin could still silently overwrite a sale, which is the
exact scenario above.

## What this does NOT change

The overselling guard is untouched. Reserving stock is still a conditional
`UPDATE ... WHERE stock >= qty`, and that remains the thing that makes two
simultaneous purchases safe. The version is a *separate* concern - edit conflicts
- and the two coexist because the version bump is part of the same atomic
statement as the stock change.

This matters: the two mechanisms protect different invariants, and confusing them
would be easy. `decrementStock` answers "is there enough to sell?". The version
answers "was this edit based on what is actually there?".

## Considered options

- **`updated_at` comparison** - rejected. Timestamps have resolution limits and
  clock assumptions; a monotonic integer has neither and costs nothing.
- **Locking the row for the duration of the admin's edit** - rejected. It holds a
  lock across human think-time, which is exactly what a database lock must never
  do.
- **Last-write-wins with a warning** - rejected. A warning that can be ignored is
  not a guarantee, and the failure is silent inventory loss.

## Consequences

- Two admins editing the same product will occasionally see `stale-edit`. That is
  the mechanism working, not a fault, and the message says so.
- Every stock write now touches two columns instead of one. Negligible.
- The customer path's version bump means an admin's read is invalidated by any
  sale on that product. Slightly more `stale-edit` responses during busy periods,
  in exchange for never losing a sale.
