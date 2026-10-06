/**
 * Admin sign-in (/admin/login).
 *
 * Note what this page does NOT do: it does not `requireAdmin()`, because the
 * whole point is to reach it while signed out. It does redirect an already
 * signed-in admin straight to the dashboard, so a stale bookmark does not show
 * a login form to someone who is already in.
 *
 * The `next` value is passed through so a deep link survives the login, and the
 * action sanitises it before redirecting.
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/auth/guard";
import { LoginForm } from "@/components/admin/login-form";

export const metadata: Metadata = { title: "Admin sign in", robots: { index: false } };

type PageProps = { searchParams: Promise<{ next?: string }> };

export default async function AdminLoginPage({ searchParams }: PageProps) {
  const session = await getAdminSession();
  if (session) redirect("/admin");

  const { next } = await searchParams;

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <h1 className="text-2xl font-bold tracking-tight">Admin sign in</h1>
      <p className="mt-2 text-sm text-slate-600">
        This area is for the shop owner.
      </p>
      <LoginForm next={next ?? "/admin"} />
    </main>
  );
}
