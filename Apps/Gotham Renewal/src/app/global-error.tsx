"use client";

/**
 * Global error boundary.
 *
 * Catches a throw from any Server Component render that no closer boundary
 * handles. Without one, an unexpected database error shows the customer a raw
 * Next.js error page - which, in development, includes a stack trace, and in
 * production a bare "Application error" with no way forward.
 *
 * `error.digest` is the only safe thing to show: it is a hash Next generates for
 * the server-side log entry, so a customer can quote it and the owner can find
 * the matching stack in the logs. The message itself may contain internals, so
 * it is not rendered.
 */
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Reaches the browser console and any client-side reporting. The server has
    // already logged the full error with the same digest.
    console.error("Unhandled application error", error.digest ?? "no digest");
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-dvh bg-white text-slate-900 antialiased">
        <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight">Something went wrong</h1>
          <p className="mt-3 text-slate-600">
            We could not load this page. Your cart is safe, and no order was
            placed.
          </p>
          {error.digest && (
            <p className="mt-2 text-xs text-slate-400">
              Reference: {error.digest}
            </p>
          )}
          <div className="mt-8 flex justify-center gap-3">
            <button
              type="button"
              onClick={reset}
              className="rounded-md bg-slate-900 px-5 py-2.5 text-sm font-medium text-white"
            >
              Try again
            </button>
            {/*
              A plain anchor, not next/link, is correct HERE: global-error
              replaces the root layout and renders its own <html>/<body>, so the
              client router's context is not guaranteed to be present. A full
              document navigation is the reliable escape. The lint rule assumes a
              normal page, so it is disabled for this one line with the reason.
            */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/"
              className="rounded-md border border-slate-300 px-5 py-2.5 text-sm font-medium"
            >
              Go home
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
