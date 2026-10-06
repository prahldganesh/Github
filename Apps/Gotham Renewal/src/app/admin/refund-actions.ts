"use server";

/**
 * Admin refund actions.
 *
 * TWO ACTIONS, not one, and the difference matters:
 *
 *   - `issueRefundAction` sends money back. It re-verifies authorization and
 *     eligibility on the server from the database, never from the form.
 *   - `reconcileRefundAction` asks the provider what happened to an attempt
 *     whose outcome is unknown. It deliberately does NOT retry the refund: a
 *     timeout may mean the money already moved, so the only safe next step is to
 *     find out.
 *
 * Authorization is checked FIRST, in each action, because server actions are
 * individually addressable POST endpoints - a form hidden behind a login is not
 * a control.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { assertAdmin } from "@/lib/auth/guard";
import { issueRefund, messageForRefundProblem, reconcileRefund } from "@/lib/payments/refunds";
import { rateLimitByKey } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/** Refresh the views that show refund state. */
function revalidateRefundViews(orderId: string): void {
  revalidatePath("/admin");
  revalidatePath("/admin/orders");
  revalidatePath(`/admin/orders/${orderId}`);
}

export async function issueRefundAction(formData: FormData): Promise<void> {
  try {
    await assertAdmin();
  } catch {
    redirect("/admin/login");
  }

  const orderId = String(formData.get("orderId") ?? "");
  if (!orderId) {
    redirect(`/admin/orders?error=${encodeURIComponent("A refund needs an order.")}`);
  }

  // A refund is an expensive, money-moving mutation. Even authenticated, a
  // stuck retry loop or a double-submit should be bounded. The service's
  // idempotency is what actually prevents a double refund; this only limits how
  // hard we hammer the provider.
  const limit = await rateLimitByKey("issue-refund", { limit: 10, windowMs: 60_000 });
  if (!limit.ok) {
    redirect(
      `/admin/orders/${orderId}?error=${encodeURIComponent("Too many refund attempts. Please wait a moment.")}`,
    );
  }

  // The service re-reads the order and re-checks eligibility. The form's hidden
  // fields are not consulted for anything but the id.
  const result = await issueRefund(orderId);

  revalidateRefundViews(orderId);

  if (!result.ok) {
    logger.warn("refund not issued", { orderId, kind: result.problem.kind });
    redirect(
      `/admin/orders/${orderId}?error=${encodeURIComponent(messageForRefundProblem(result.problem))}`,
    );
  }

  redirect(
    `/admin/orders/${orderId}?refunded=${encodeURIComponent(result.refund.providerRefundId ?? result.refund.id)}`,
  );
}

export async function reconcileRefundAction(formData: FormData): Promise<void> {
  try {
    await assertAdmin();
  } catch {
    redirect("/admin/login");
  }

  const orderId = String(formData.get("orderId") ?? "");
  if (!orderId) {
    redirect(`/admin/orders?error=${encodeURIComponent("A reconciliation needs an order.")}`);
  }

  const result = await reconcileRefund(orderId);

  revalidateRefundViews(orderId);

  const message = `${result.status}: ${result.detail}`;
  redirect(
    result.ok
      ? `/admin/orders/${orderId}?reconciled=${encodeURIComponent(message)}`
      : `/admin/orders/${orderId}?error=${encodeURIComponent(message)}`,
  );
}
