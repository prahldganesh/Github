# 0009: An admin edits stock absolutely, never by increment

**Status:** accepted

## Context

An admin fixing inventory needs to say "there are 12 on the shelf". The
tempting implementation reuses the order path's `incrementStock`, and the
obvious-looking API is "add 5" or "remove 3".

But an increment is only correct if the number it applies to is right. If the
admin's screen showed 20 and the real count is 17 (a sale happened, a unit was
damaged), "+5" produces 22 — and the error is now permanently baked in, twice
over. Increments compound drift; they cannot correct it.

## Decision

Admin stock edits are **absolute**: `setStock(id, stock)` writes the number the
admin typed. The value must be a non-negative whole number; anything else is
refused rather than silently stored.

The order path keeps using increments/decrements with a guard, because there the
operation genuinely is "reserve one more unit" and the guard makes it safe under
concurrency (ADR-0003). The two are different operations and are deliberately
different functions.

## Consequences

- The admin's UI must show the current stock clearly, because they are asserting
  a fact rather than applying a delta.
- `setStock` is narrow on purpose. It cannot touch the price or the name, so a
  bug in the stock form cannot corrupt anything else.
- **Update (ADR-0012):** the stale-overwrite gap described in the original
  version of this record has been closed. A `version` column is bumped by every
  stock write, including the customer purchase path, and an admin edit is
  conditional on it. A stale save is refused with `stale-edit` rather than
  silently winning.
