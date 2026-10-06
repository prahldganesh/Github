"use client";

/**
 * Sign-in form.
 *
 * A Client Component only because it needs `useActionState` to show the error
 * returned by the server action. The password itself never leaves the browser
 * except in the POST body to our own server, over the same origin.
 */
import { useActionState } from "react";
import { loginAction, type LoginState } from "@/lib/auth/actions";

const initialState: LoginState = {};

export function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(loginAction, initialState);

  return (
    <form action={formAction} className="mt-8 space-y-4">
      <input type="hidden" name="next" value={next} />

      <div>
        <label htmlFor="password" className="text-sm font-medium text-slate-700">
          Admin password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
        />
      </div>

      {state.error && (
        <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-slate-900 px-6 py-3 font-medium text-white disabled:bg-slate-400"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
