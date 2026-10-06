/**
 * Order status transitions.
 *
 * The rules for how an Order may move between statuses, as a pure function.
 * Keeping them out of the UI means a status cannot be changed to something
 * illegal by hand-crafting a request, and the rules are testable without a
 * database or a browser.
 *
 * The state machine:
 *
 *   NEW ──▶ CONFIRMED ──▶ PACKED ──▶ SHIPPED ──▶ DELIVERED
 *    │          │            │           │
 *    └──────────┴────────────┴───────────┴──▶ CANCELLED
 *
 * CANCELLED is terminal: once cancelled, nothing else happens. DELIVERED is
 * also terminal. `NEW` may be cancelled directly because a COD order the shop
 * cannot fulfil should be cancellable without pretending it was confirmed.
 */
import type { OrderStatus } from "@/generated/prisma/enums";

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  NEW: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PACKED", "CANCELLED"],
  PACKED: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED", "CANCELLED"],
  DELIVERED: [], // terminal
  CANCELLED: [], // terminal
};

/** The statuses an order may move to from its current one. */
export function allowedNextStatuses(current: OrderStatus): readonly OrderStatus[] {
  return TRANSITIONS[current];
}

/** Whether a transition is permitted. */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Whether moving into this status should return the reserved stock.
 *
 * Cancelling is the only status change that gives stock back. Note there is no
 * "un-cancel", so this can never double-return stock for one order.
 */
export function shouldRestock(to: OrderStatus): boolean {
  return to === "CANCELLED";
}

/** Human explanation of why a transition is refused. */
export function transitionRefusal(from: OrderStatus, to: OrderStatus): string {
  if (from === to) return `This order is already ${from}.`;
  if (TRANSITIONS[from].length === 0) {
    return `A ${from} order cannot be changed.`;
  }
  return `An order cannot go from ${from} to ${to}.`;
}
