/**
 * Site configuration.
 *
 * The BUSINESS identity, in one place. This is the only file that should hold
 * the customer-facing name - pages read `site.name` rather than hardcoding it,
 * so a rename is a one-line change.
 *
 * Note the two names, which are both correct and serve different purposes:
 *
 *   - `name` is the shop's everyday name, what customers and the admin UI see.
 *   - The full registered name, "Adambakkam Sri Srinivasa Boli Stall", appears
 *     in `description` where there is room for it. It is deliberately NOT a
 *     separate field: nothing reads it programmatically, and an unused field is
 *     a field that silently goes stale.
 *
 * Non-secret, display-level settings only. Everything secret or environment
 * dependent lives in `src/lib/env.ts` (server-only).
 */

export const site = {
  name: "Sri Srinivasa Boli Stall",
  tagline: "Fresh boli, made every morning.",
  description:
    "Adambakkam Sri Srinivasa Boli Stall is a family-run sweet stall serving fresh boli and traditional sweets. Order online with cash on delivery, UPI or card.",
} as const;
