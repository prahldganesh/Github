import type { NextConfig } from "next";

/**
 * Security headers.
 *
 * Set here rather than in a route or a proxy so they apply to every response,
 * including static assets and error pages.
 *
 * The reasoning behind each:
 *
 * - `X-Frame-Options: DENY` - the site must not be framed. Clickjacking a
 *   checkout (or an admin screen that issues refunds) is a real attack.
 * - `X-Content-Type-Options: nosniff` - stop a browser guessing a content type.
 *   Uploaded images are validated, but this is the defence-in-depth layer that
 *   stops a mis-served file being treated as script.
 * - `Referrer-Policy: strict-origin-when-cross-origin` - the confirmation URL
 *   carries an access token. Without this, navigating away would leak that token
 *   in the `Referer` header to the destination site.
 * - `Strict-Transport-Security` - once a browser has seen this over HTTPS it
 *   refuses plain HTTP for the site, so a downgrade cannot silently happen.
 *   Deliberately only in production: over localhost HTTP it would be ignored at
 *   best and confusing at worst.
 * - `Permissions-Policy` - the storefront needs none of these. Turning them off
 *   removes a capability an injected script could otherwise reach for. `payment`
 *   is left enabled for the origin because Razorpay Checkout is a legitimate use.
 * - A `Content-Security-Policy` is included in report-only mode. It is NOT
 *   enforced, because a wrong CSP breaks checkout silently and this app embeds a
 *   third-party payment script - so it is shipped as a way to observe violations
 *   in production first. Flip `Content-Security-Policy-Report-Only` to
 *   `Content-Security-Policy` once the reports are clean. See DEPLOYMENT.md.
 */
const isProduction = process.env.NODE_ENV === "production";

/**
 * The policy reflects what the app actually loads:
 *  - Razorpay's checkout script and frames (payments)
 *  - its own Next.js runtime
 *  - inline styles, which Tailwind and Next inject
 * `unsafe-inline` for styles is a deliberate, low-risk concession; script
 * `unsafe-inline` is NOT allowed.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' https://checkout.razorpay.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:", // product images are external URLs
  "font-src 'self' data:",
  "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com",
  "frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(self)",
  },
  // Report-only for now: it observes without breaking checkout.
  { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy },
  ...(isProduction
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  // Do not advertise the framework. Minor, but there is no reason to help.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
