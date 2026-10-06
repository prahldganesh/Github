"use client";

/**
 * Razorpay Checkout, browser side.
 *
 * Loads Razorpay's `checkout.js` on demand and opens their payment UI. This
 * file is about user experience ONLY.
 *
 * The important thing it does NOT do: it never tells the server that payment
 * succeeded. Razorpay's `handler` callback fires in the customer's browser and
 * can be spoofed or simply never fire (a closed tab). The server marks the
 * order paid only when the signed webhook arrives (ADR-0002). So the browser's
 * job here is to hand the customer to Razorpay and then send them to the
 * confirmation page, where the true payment status is read from the database.
 */

const CHECKOUT_SCRIPT = "https://checkout.razorpay.com/v1/checkout.js";

type RazorpayOptions = {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  prefill?: { name?: string; email?: string; contact?: string };
  notes?: Record<string, string>;
  theme?: { color?: string };
  handler?: (response: RazorpayHandlerResponse) => void;
  modal?: { ondismiss?: () => void };
};

export type RazorpayHandlerResponse = {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
};

type RazorpayInstance = { open: () => void; on: (event: string, cb: () => void) => void };

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

/** Load checkout.js once; reuse it on later attempts. */
let loaderPromise: Promise<boolean> | null = null;

export function loadRazorpayScript(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);

  loaderPromise ??= new Promise<boolean>((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_SCRIPT}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(true));
      existing.addEventListener("error", () => resolve(false));
      return;
    }
    const script = document.createElement("script");
    script.src = CHECKOUT_SCRIPT;
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });

  return loaderPromise;
}

export type OpenCheckoutInput = {
  keyId: string;
  razorpayOrderId: string;
  amountPaise: number;
  currency: string;
  siteName: string;
  customer: { name: string; email?: string; phone: string };
  /** Called after Razorpay reports success. NOT proof of payment. */
  onPaid: (response: RazorpayHandlerResponse) => void;
  /** Called when the customer closes the modal without paying. */
  onDismiss: () => void;
};

/**
 * Open the Razorpay modal. Resolves to false when the script could not load.
 */
export async function openRazorpayCheckout(input: OpenCheckoutInput): Promise<boolean> {
  const loaded = await loadRazorpayScript();
  if (!loaded || !window.Razorpay) return false;

  const instance = new window.Razorpay({
    key: input.keyId,
    order_id: input.razorpayOrderId,
    amount: input.amountPaise,
    currency: input.currency,
    name: input.siteName,
    description: "Order payment",
    prefill: {
      name: input.customer.name,
      email: input.customer.email,
      contact: input.customer.phone,
    },
    theme: { color: "#0f172a" },
    handler: input.onPaid,
    modal: { ondismiss: input.onDismiss },
  });

  instance.open();
  return true;
}
