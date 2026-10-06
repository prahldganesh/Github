/**
 * Order status transition tests.
 *
 * A state machine is exactly the kind of logic that looks obviously correct and
 * is not, so every rule is asserted - including the terminal states and the
 * restock decision.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowedNextStatuses,
  canTransition,
  shouldRestock,
  transitionRefusal,
} from "./status";

test("the happy path is allowed step by step", () => {
  assert.ok(canTransition("NEW", "CONFIRMED"));
  assert.ok(canTransition("CONFIRMED", "PACKED"));
  assert.ok(canTransition("PACKED", "SHIPPED"));
  assert.ok(canTransition("SHIPPED", "DELIVERED"));
});

test("skipping a step is refused", () => {
  assert.ok(!canTransition("NEW", "PACKED"));
  assert.ok(!canTransition("NEW", "SHIPPED"));
  assert.ok(!canTransition("NEW", "DELIVERED"));
  assert.ok(!canTransition("CONFIRMED", "SHIPPED"));
  assert.ok(!canTransition("PACKED", "DELIVERED"));
});

test("a new order may be cancelled directly", () => {
  assert.ok(canTransition("NEW", "CANCELLED"));
});

test("cancelling is allowed from every non-terminal status", () => {
  for (const status of ["NEW", "CONFIRMED", "PACKED", "SHIPPED"] as const) {
    assert.ok(canTransition(status, "CANCELLED"), `${status} should be cancellable`);
  }
});

test("DELIVERED and CANCELLED are terminal", () => {
  for (const terminal of ["DELIVERED", "CANCELLED"] as const) {
    for (const target of [
      "NEW",
      "CONFIRMED",
      "PACKED",
      "SHIPPED",
      "DELIVERED",
      "CANCELLED",
    ] as const) {
      assert.ok(!canTransition(terminal, target), `${terminal} -> ${target} must be refused`);
    }
    assert.equal(allowedNextStatuses(terminal).length, 0);
  }
});

test("there is no un-cancel", () => {
  assert.ok(!canTransition("CANCELLED", "CONFIRMED"));
  assert.ok(!canTransition("CANCELLED", "NEW"));
});

test("only cancelling returns stock", () => {
  assert.ok(shouldRestock("CANCELLED"));
  assert.ok(!shouldRestock("CONFIRMED"));
  assert.ok(!shouldRestock("PACKED"));
  assert.ok(!shouldRestock("SHIPPED"));
  assert.ok(!shouldRestock("DELIVERED"));
});

test("allowedNextStatuses matches canTransition", () => {
  for (const from of ["NEW", "CONFIRMED", "PACKED", "SHIPPED", "DELIVERED", "CANCELLED"] as const) {
    for (const to of ["NEW", "CONFIRMED", "PACKED", "SHIPPED", "DELIVERED", "CANCELLED"] as const) {
      assert.equal(
        allowedNextStatuses(from).includes(to),
        canTransition(from, to),
        `${from} -> ${to} disagrees between the two functions`,
      );
    }
  }
});

test("refusals explain themselves", () => {
  assert.match(transitionRefusal("NEW", "NEW"), /already NEW/);
  assert.match(transitionRefusal("DELIVERED", "SHIPPED"), /cannot be changed/);
  assert.match(transitionRefusal("NEW", "DELIVERED"), /cannot go from NEW to DELIVERED/);
});
