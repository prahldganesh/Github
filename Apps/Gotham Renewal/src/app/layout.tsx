import type { Metadata } from "next";
import "./globals.css";
import { CartProvider } from "@/lib/cart/context";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: { default: site.name, template: `%s | ${site.name}` },
  description: site.description,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-white text-slate-900 antialiased">
        {/*
          The cart lives in the browser, so its provider wraps the whole tree.
          It is a Client Component nested inside a Server Component layout -
          which is the supported direction: a server component may render a
          client one, and the children stay server-rendered.
        */}
        <CartProvider>{children}</CartProvider>
      </body>
    </html>
  );
}
