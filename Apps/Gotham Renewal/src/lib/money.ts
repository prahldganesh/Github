/**
 * Money helpers.
 *
 * All monetary values in this application are integers in PAISE (1 rupee =
 * 100 paise). We never store or compute money as a JavaScript `number` of
 * rupees, because IEEE-754 floating point cannot represent values like 0.1 or
 * 2480.5 exactly and the errors accumulate across line items.
 *
 * `type Paise = number` is a brand in spirit only - TypeScript cannot stop you
 * adding two plain numbers - but naming the unit everywhere makes the mistake
 * obvious in review. Phase 5 will add runtime guards around arithmetic.
 */

export type Paise = number;

/** Convert rupees (may be fractional) to paise, rounding to the nearest paise. */
export function rupeesToPaise(rupees: number): Paise {
  return Math.round(rupees * 100);
}

/** Format paise for display, e.g. 248050 -> "₹2,480.50". */
export function formatPaise(paise: Paise, locale = "en-IN"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "INR",
  }).format(paise / 100);
}

/**
 * Sum a list of paise amounts. Integer addition is exact; this exists so call
 * sites never reach for `.reduce((a, b) => a + b, 0)` and accidentally divide
 * by 100 somewhere along the way.
 */
export function sumPaise(amounts: readonly Paise[]): Paise {
  return amounts.reduce((total, amount) => total + amount, 0);
}

/**
 * Line total for a quantity at a unit price. Integer multiplication, exact.
 * Guarded because a negative or fractional quantity means a bug upstream.
 */
export function lineTotalPaise(unitPrice: Paise, quantity: number): Paise {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`lineTotalPaise: quantity must be a positive integer, got ${quantity}`);
  }
  return unitPrice * quantity;
}
