"use client";

/**
 * Checkout page (/checkout).
 *
 * The key security property is visible right here: this form builds a request
 * containing the customer's details, the payment method, and `{productId,
 * quantity}` pairs. It contains no prices and no total. The button posts to
 * `/api/orders`, and the amount charged is whatever the server computes from
 * the database.
 *
 * The displayed total is a *preview* computed on the client from cached cart
 * prices. It is never sent. If it disagrees with the server (a price changed
 * while the customer was shopping), the server's number is what is charged and
 * what the confirmation page shows.
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCart } from "@/lib/cart/context";
import { formatPaise } from "@/lib/money";
import { site } from "@/lib/site";
import { openRazorpayCheckout } from "@/lib/payments/razorpay/checkout-client";

type FieldErrors = Record<string, string>;

const emptyForm = {
  name: "",
  phone: "",
  email: "",
  address: "",
  city: "",
  state: "",
  pincode: "",
};

export default function CheckoutPage() {
  const router = useRouter();
  const { cart, hydrated, subtotalPaise, countLines, clearCart } = useCart();
  const [form, setForm] = useState(emptyForm);
  const [paymentMethod, setPaymentMethod] = useState<"COD" | "RAZORPAY">("COD");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /**
   * An order that was created even though the response was a failure. Set when
   * Razorpay could not be started: the order exists and holds stock, so the
   * customer is offered a way to it instead of a dead end.
   */
  const [savedOrder, setSavedOrder] = useState<{ id: string; accessToken: string } | null>(null);

  function update(field: keyof typeof emptyForm, value: string) {
    setForm((previous) => ({ ...previous, [field]: value }));
  }

  /** Navigate to the confirmation page, which reads the real status from the DB. */
  function goToConfirmation(orderId: string, accessToken: string) {
    clearCart();
    router.push(`/order-success/${orderId}?token=${encodeURIComponent(accessToken)}`);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setErrors({});
    setFormError(null);

    // Product ids and quantities ONLY. No prices, no total, no status.
    const payload = {
      customer: {
        name: form.name,
        phone: form.phone,
        email: form.email,
        address: form.address,
        city: form.city,
        state: form.state,
        pincode: form.pincode,
      },
      paymentMethod,
      items: cart.lines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
      })),
    };

    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        fields?: FieldErrors;
        order?: { id: string; accessToken?: string } | null;
        razorpay?: {
          razorpayOrderId: string;
          keyId: string;
          amountPaise: number;
          currency: string;
        } | null;
      };

      if (!response.ok) {
        setErrors(data.fields ?? {});
        setFormError(data.error ?? "Could not place your order. Please try again.");

        // An order may still have been created (Razorpay could not be started).
        // It holds stock, so the customer must be able to reach it rather than
        // leaving an invisible order behind.
        if (data.order?.id && data.order.accessToken) {
          setSavedOrder({ id: data.order.id, accessToken: data.order.accessToken });
        }
        setSubmitting(false);
        return;
      }

      if (!data.order?.id || !data.order.accessToken) {
        setFormError("Order was placed but we could not open the confirmation page.");
        setSubmitting(false);
        return;
      }

      // --- COD: done. The order is confirmed and the owner is alerted. -----
      if (!data.razorpay) {
        goToConfirmation(data.order.id, data.order.accessToken);
        return;
      }

      // --- Razorpay: hand the customer to the payment UI. ------------------
      const orderId = data.order.id;
      const accessToken = data.order.accessToken;
      const razorpay = data.razorpay;

      const opened = await openRazorpayCheckout({
        keyId: razorpay.keyId,
        razorpayOrderId: razorpay.razorpayOrderId,
        amountPaise: razorpay.amountPaise,
        currency: razorpay.currency,
        siteName: site.name,
        customer: { name: form.name, email: form.email, phone: form.phone },
        // Razorpay reports success in the browser. This is NOT proof of
        // payment - the signed webhook is - so we only navigate. The
        // confirmation page reads the authoritative status from the database,
        // which may still be PENDING for a moment. The response argument is
        // deliberately ignored: nothing it contains can be trusted, and the
        // server never asks for it.
        onPaid: () => {
          goToConfirmation(orderId, accessToken);
        },
        onDismiss: () => {
          // The order exists and holds its stock; the customer can pay later.
          setFormError(
            "Payment was not completed. Your order is saved - you can try paying again from this page.",
          );
          setSubmitting(false);
        },
      });

      if (!opened) {
        setFormError(
          "We could not open the payment window. Please check your connection and try again.",
        );
        setSubmitting(false);
      }
    } catch {
      setFormError("Network error. Please check your connection and try again.");
      setSubmitting(false);
    }
  }

  if (!hydrated) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-2xl font-bold tracking-tight">Checkout</h1>
        <p className="mt-4 text-slate-500">Loading your cart…</p>
      </main>
    );
  }

  if (countLines === 0) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-2xl font-bold tracking-tight">Checkout</h1>
        <p className="mt-4 text-slate-600">Your cart is empty.</p>
        <Link
          href="/products"
          className="mt-6 inline-block rounded-md bg-slate-900 px-6 py-3 font-medium text-white"
        >
          Browse products
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-bold tracking-tight">Checkout</h1>

      <form onSubmit={handleSubmit} className="mt-8 space-y-6" noValidate>
        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Delivery details
          </legend>

          <Field label="Full name" name="name" value={form.name} error={errors["customer.name"]} onChange={update} autoComplete="name" />
          <Field label="Phone" name="phone" value={form.phone} error={errors["customer.phone"]} onChange={update} autoComplete="tel" inputMode="tel" />
          <Field label="Email (optional)" name="email" value={form.email} error={errors["customer.email"]} onChange={update} autoComplete="email" />
          <Field label="Address" name="address" value={form.address} error={errors["customer.address"]} onChange={update} autoComplete="street-address" textarea />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="City" name="city" value={form.city} error={errors["customer.city"]} onChange={update} autoComplete="address-level2" />
            <Field label="State" name="state" value={form.state} error={errors["customer.state"]} onChange={update} autoComplete="address-level1" />
            <Field label="PIN code" name="pincode" value={form.pincode} error={errors["customer.pincode"]} onChange={update} autoComplete="postal-code" inputMode="numeric" />
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Payment
          </legend>

          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-300 p-4">
            <input
              type="radio"
              name="paymentMethod"
              checked={paymentMethod === "COD"}
              onChange={() => setPaymentMethod("COD")}
              className="mt-1"
            />
            <span>
              <span className="font-medium">Cash on delivery</span>
              <span className="mt-0.5 block text-sm text-slate-500">
                Pay in cash when your order arrives.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-300 p-4">
            <input
              type="radio"
              name="paymentMethod"
              checked={paymentMethod === "RAZORPAY"}
              onChange={() => setPaymentMethod("RAZORPAY")}
              className="mt-1"
            />
            <span>
              <span className="font-medium">Pay online (UPI, card, netbanking)</span>
              <span className="mt-0.5 block text-sm text-slate-500">
                Secure payment via Razorpay.
              </span>
            </span>
          </label>
        </fieldset>

        <div className="rounded-md border border-slate-200 p-4">
          <div className="flex justify-between text-slate-600">
            <span>Subtotal</span>
            <span>{formatPaise(subtotalPaise)}</span>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Shipping and the final total are calculated on the server when you place
            the order.
          </p>
        </div>

        {formError && (
          <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">
            <p>{formError}</p>
            {savedOrder && (
              <button
                type="button"
                onClick={() => goToConfirmation(savedOrder.id, savedOrder.accessToken)}
                className="mt-2 font-medium underline"
              >
                View your saved order
              </button>
            )}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-slate-900 px-6 py-3 font-medium text-white hover:bg-slate-800 disabled:bg-slate-400"
        >
          {submitting ? "Placing your order…" : "Place order"}
        </button>
      </form>
    </main>
  );
}

function Field({
  label,
  name,
  value,
  error,
  onChange,
  autoComplete,
  inputMode,
  textarea,
}: {
  label: string;
  name: keyof typeof emptyForm;
  value: string;
  error?: string;
  onChange: (field: keyof typeof emptyForm, value: string) => void;
  autoComplete?: string;
  inputMode?: "tel" | "numeric" | "text" | "email";
  textarea?: boolean;
}) {
  const inputClass = `mt-1 w-full rounded-md border px-3 py-2 ${
    error ? "border-red-400" : "border-slate-300"
  }`;

  return (
    <div>
      <label htmlFor={name} className="text-sm font-medium text-slate-700">
        {label}
      </label>
      {textarea ? (
        <textarea
          id={name}
          name={name}
          rows={3}
          value={value}
          onChange={(event) => onChange(name, event.target.value)}
          autoComplete={autoComplete}
          className={inputClass}
        />
      ) : (
        <input
          id={name}
          name={name}
          type="text"
          value={value}
          onChange={(event) => onChange(name, event.target.value)}
          autoComplete={autoComplete}
          inputMode={inputMode}
          className={inputClass}
        />
      )}
      {error && <p className="mt-1 text-sm text-red-700">{error}</p>}
    </div>
  );
}
