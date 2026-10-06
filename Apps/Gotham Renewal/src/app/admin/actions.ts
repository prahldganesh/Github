"use server";

/**
 * Admin server actions for orders.
 *
 * Every action calls `assertAdmin()` first. This is not belt-and-braces: server
 * actions are individually addressable POST endpoints, so an action that trusts
 * "the page was behind a guard" is directly callable by anyone who knows its id.
 * The check must be inside the action.
 *
 * Signature note: this takes `FormData` only, because it is used as a plain
 * `<form action={...}>` from a Server Component. (An action intended for
 * `useActionState` would instead take `(previousState, formData)`.) Errors are
 * reported by redirecting back with a query parameter, which keeps the detail
 * page a Server Component.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { assertAdmin } from "@/lib/auth/guard";
import { updateOrderStatus } from "@/lib/orders/admin-service";
import type { OrderStatus } from "@/generated/prisma/enums";

const VALID_STATUSES: readonly OrderStatus[] = [
  "NEW",
  "CONFIRMED",
  "PACKED",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
];

function isOrderStatus(value: string): value is OrderStatus {
  return (VALID_STATUSES as readonly string[]).includes(value);
}

export async function updateOrderStatusAction(formData: FormData): Promise<void> {
  const orderId = String(formData.get("orderId") ?? "");
  const nextStatus = String(formData.get("status") ?? "");

  // Not signed in: send them to the login page rather than pretending success.
  try {
    await assertAdmin();
  } catch {
    redirect("/admin/login");
  }

  // A malformed submission is a bug or a forgery, not a user error.
  if (!orderId || !isOrderStatus(nextStatus)) {
    redirect(`/admin/orders?error=${encodeURIComponent("Invalid status change.")}`);
  }

  const result = await updateOrderStatus(orderId, nextStatus);

  if (!result.ok) {
    redirect(`/admin/orders/${orderId}?error=${encodeURIComponent(result.message)}`);
  }

  // Both views show the status, so both are refreshed.
  revalidatePath("/admin/orders");
  revalidatePath(`/admin/orders/${orderId}`);
  redirect(`/admin/orders/${orderId}?updated=${encodeURIComponent(result.status)}`);
}
