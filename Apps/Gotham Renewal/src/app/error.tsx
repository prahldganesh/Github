"use client";

/**
 * Storefront error boundary.
 *
 * Catches a throw from any page below it (the catalogue, a product, checkout,
 * the confirmation page). Scoped inside the root layout, so the site header and
 * footer still render and the customer is never stranded on a blank page.
 *
 * Deliberately shows the digest, not the message: the message can carry
 * internal detail, and the digest is what ties this to the server log.
 */
import { useEffect } from "react";
import Link from "next/link";

export default function StorefrontError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Storefront error", error.digest ?? "no digest");
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[60dvh] max-w-md flex-col justify-center px-6 py-16 text-center">
      <h1 className="text-2xl font-bold tracking-tight">Something went wrong</h1>
      <p className="mt-3 text-slate-600">
        We could not load this page. Your cart is safe, and no order was placed.
      </p>
      {error.digest && (
        <p className="mt-2 text-xs text-slate-400">Reference: {error.digest}</p>
      )}
      <div className="mt-8 flex justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-md bg-slate-900 px-5 py-2.5 text-sm font-medium text-white"
        >
          Try again
        </button>
        <Link
          href="/products"
          className="rounded-md border border-slate-300 px-5 py-2.5 text-sm font-medium"
        >
          Browse products
        </Link>
      </div>
    </main>
  );
}
