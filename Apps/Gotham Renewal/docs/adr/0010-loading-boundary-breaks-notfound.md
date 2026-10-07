# 0010: A `loading.tsx` must not wrap a route that can 404

**Status:** accepted

## Context

Adding `src/app/products/loading.tsx` to show a skeleton while the catalogue
loads seemed harmless. It was not.

A `loading.tsx` creates a React Suspense boundary around its segment. Next then
**streams** the response: it sends the shell — including the HTTP status line —
immediately, and fills in the content as it resolves. Once that status line is
committed, it cannot be changed.

`products/[slug]/page.tsx` calls `notFound()` when a product is missing or
inactive. With a loading boundary above it, the 200 is already sent by the time
`notFound()` runs, so Next renders the not-found UI **inside a 200 response**.
This is a soft 404: the visitor sees the right page, but `curl` reports `200`,
search engines may index the empty page, and monitoring cannot tell it apart
from a real one.

This was caught by `check:products-browser`, which asserts a disabled product
returns 404. It had passed before the loading file was added, and started failing
consistently afterwards — the kind of regression that is easy to ship because the
page *looks* correct in a browser.

## Decision

Keep loading boundaries **off** any route that can call `notFound()`.

The catalogue's skeleton moved to `src/app/products/(list)/loading.tsx`, which
covers only the list page. `products/[slug]/` has no loading file, so its
`notFound()` still sets a real 404. The route group `(list)` is not part of the
URL — `/products` is unchanged.

## Consequences

- The product **detail** page loses its skeleton and shows the previous page
  until the new one is ready. That is the correct trade: a correct status code
  matters more than a spinner, and a product page is a fast query.
- **Update (Phase B):** the admin `loading.tsx` has since been **removed**. The
  original reasoning above — that an admin soft 404 is harmless because it is only
  reached from a stale link — stopped holding once `/admin/customers/[phone]` was
  added, where "no such customer" is a *normal* outcome rather than a mistake.
  Measured: all four admin detail routes that call `notFound()`
  (`/admin/orders/[id]`, `/admin/products/[id]`, `/admin/customers/[phone]`, and a
  malformed id) returned **200**. Removing the single loading file made all four
  return **404**, with every real page still 200.
  The cost is the admin skeleton; correctness of the status code is worth more
  than a brief placeholder on pages that already resolve in milliseconds. Keeping
  both would mean a route group per list page (as `products/(list)/` does), which
  is more restructuring than the skeleton is worth.
- The rule generalises: **if a segment can `notFound()`, do not give it an
  ancestor `loading.tsx`.** Verify with
  `curl -o /dev/null -w '%{http_code}'` on a known-missing path after adding one.
