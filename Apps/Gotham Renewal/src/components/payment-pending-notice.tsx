"use client";

/**
 * "We're confirming your payment" notice.
 *
 * Shown on the confirmation page when an online payment has not yet been
 * confirmed by the webhook. The customer just paid, so a bare "Pending" reads
 * as a failure; this explains that the bank's confirmation is in flight.
 *
 * It polls a read-only status endpoint and refreshes the page when the
 * server-rendered status stops being PENDING. It is a DISPLAY convenience only:
 *
 *   - It never tells the server that payment succeeded. There is no endpoint it
 *     could call to do that, by design (ADR-0002).
 *   - It stops after a bounded number of attempts, so an order that is never
 *     paid does not poll forever.
 *   - If it gives up, the order is safe regardless: the webhook marks it paid
 *     whenever it arrives. Refreshing the page later shows the truth.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const POLL_INTERVAL_MS = 3000;
const MAX_ATTEMPTS = 10; // ~30 seconds, then stop and tell the customer.

export function PaymentPendingNotice({
  orderId,
  token,
}: {
  orderId: string;
  token: string;
}) {
  const router = useRouter();
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    // A local attempt counter, not React state: it drives no rendering, and
    // putting it in state would mean setting state synchronously inside the
    // effect, which is exactly the re-render loop the lint rule guards against.
    let attempts = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      if (cancelled) return;

      if (attempts >= MAX_ATTEMPTS) {
        setGaveUp(true);
        return;
      }
      attempts += 1;

      try {
        const response = await fetch(
          `/api/orders/${orderId}/status?token=${encodeURIComponent(token)}`,
          { cache: "no-store" },
        );
        if (response.ok) {
          const data = (await response.json()) as { paymentStatus?: string };
          // The webhook landed: re-render the page from the server so the
          // status shown is the one the database now holds.
          if (data.paymentStatus && data.paymentStatus !== "PENDING") {
            if (!cancelled) router.refresh();
            return;
          }
        }
      } catch {
        // A failed poll is not worth surfacing; just try again.
      }

      if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
    }

    timer = setTimeout(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [orderId, token, router]);

  return (
    <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <p className="font-medium">We&apos;re confirming your payment with the bank.</p>
      {gaveUp ? (
        <p className="mt-1">
          This is taking longer than usual. Your order is saved - we will update it
          as soon as the payment is confirmed. You can also refresh this page later.
        </p>
      ) : (
        <p className="mt-1">This usually takes a few seconds. Please keep this page open.</p>
      )}
    </div>
  );
}
