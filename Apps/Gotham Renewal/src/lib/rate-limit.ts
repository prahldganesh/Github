/**
 * Rate limiting.
 *
 * TWO BACKENDS, chosen by configuration:
 *
 *   - **Distributed** (production): Upstash Redis, when `UPSTASH_REDIS_REST_URL`
 *     and `UPSTASH_REDIS_REST_TOKEN` are set. Counters live in one place, so the
 *     limit is real across every serverless instance. This is what production
 *     must use: an in-memory limit on Vercel is per-instance, so the effective
 *     limit is multiplied by however many instances happen to be warm.
 *   - **In-memory** (local development and tests): a module-level Map. No
 *     configuration, no network, no cost. Fine for one process.
 *
 * The fallback is chosen by whether the Upstash env vars are present, NOT by
 * NODE_ENV: a deployment that forgets them gets the in-memory limiter, which
 * still stops a naive script (per instance) but is not the real thing. The
 * startup log says which one is active so the difference is visible rather than
 * assumed. See DEPLOYMENT.md.
 *
 * FAIL-OPEN, DELIBERATELY. If Redis is unreachable or slow, a request is
 * ALLOWED rather than rejected. Rate limiting is an abuse control, not an
 * authorization control - a Redis outage must not take down checkout. The
 * security controls that actually protect money (signature verification,
 * idempotency, server-side validation) do not depend on this module.
 *
 * NOT APPLIED TO THE RAZORPAY WEBHOOK. A provider webhook is not abuse traffic,
 * and rejecting a legitimate retry would stall a real payment. That endpoint is
 * protected by HMAC verification and idempotency instead (ADR-0002).
 */
import "server-only";

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

export type RateLimitOptions = {
  /** Logical name, so two endpoints never share a bucket. */
  key: string;
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
};

// ---------------------------------------------------------------------------
// Backend detection
// ---------------------------------------------------------------------------

function upstashConfigured(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
  );
}

/** Whether the distributed limiter is active. Surfaced in logs. */
export function isDistributedRateLimiting(): boolean {
  return upstashConfigured();
}

let announced = false;
function announceBackend(): void {
  if (announced) return;
  announced = true;
  console.log(
    isDistributedRateLimiting()
      ? "[rate-limit] distributed backend active (Upstash Redis)"
      : "[rate-limit] using the IN-MEMORY backend (per-instance). Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for a real distributed limit.",
  );
}

// ---------------------------------------------------------------------------
// Distributed backend
// ---------------------------------------------------------------------------

type Limiter = { limit: (identifier: string) => Promise<{ success: boolean; reset: number }> };

const limiters = new Map<string, Limiter>();

/**
 * A limiter per (limit, window), cached.
 *
 * `timeout` is what gives the fail-open behaviour: if Redis does not answer
 * within it, Upstash resolves with `success: true` and a `reason` of "timeout",
 * so a slow Redis cannot stall a request.
 */
async function getLimiter(options: RateLimitOptions): Promise<Limiter | null> {
  if (!upstashConfigured()) return null;

  const cacheKey = `${options.limit}:${options.windowMs}`;
  const cached = limiters.get(cacheKey);
  if (cached) return cached;

  try {
    const [{ Ratelimit }, { Redis }] = await Promise.all([
      import("@upstash/ratelimit"),
      import("@upstash/redis"),
    ]);
    const limiter = new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(options.limit, `${options.windowMs} ms`),
      // Distinct prefix per endpoint, so keys cannot collide.
      prefix: `gotham:rl:${options.key}`,
      timeout: 1000,
      analytics: false,
    });
    limiters.set(cacheKey, limiter);
    return limiter;
  } catch (error) {
    // A misconfigured client must degrade, not throw into the request path.
    console.error("[rate-limit] could not initialise the distributed limiter", error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// In-memory backend
// ---------------------------------------------------------------------------

function consumeLocal(identifier: string, options: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(identifier);

  if (!bucket || bucket.resetAt <= now) {
    if (buckets.size >= MAX_BUCKETS) sweep(now);
    buckets.set(identifier, { count: 1, resetAt: now + options.windowMs });
    return { ok: true };
  }

  if (bucket.count >= options.limit) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }

  bucket.count += 1;
  return { ok: true };
}

function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Public API - unchanged signature, so callers did not move
// ---------------------------------------------------------------------------

/** Consume one request from a bucket. Never throws. */
async function consume(identifier: string, options: RateLimitOptions): Promise<RateLimitResult> {
  announceBackend();

  const limiter = await getLimiter(options);
  if (!limiter) return consumeLocal(identifier, options);

  try {
    const result = await limiter.limit(identifier);
    if (result.success) return { ok: true };
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)),
    };
  } catch (error) {
    // Fail open: an abuse control must not become an outage.
    console.error("[rate-limit] distributed check failed; allowing the request", error);
    return { ok: true };
  }
}

/**
 * Identify the caller.
 *
 * `x-forwarded-for` is set by the platform proxy and is the best signal
 * available. It is spoofable when nothing trustworthy rewrites it, which is why
 * the value is only ever used to bucket traffic, never to authorize it. The
 * left-most entry is the original client when a trusted proxy appends.
 */
function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return (
    forwarded?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    // No IP header: bucket everything together. Stricter, not looser.
    "unknown"
  );
}

export async function rateLimit(
  request: Request,
  options: RateLimitOptions,
): Promise<RateLimitResult> {
  return consume(`${options.key}:${clientIp(request)}`, options);
}

/**
 * Rate limit by a logical name, reading headers directly.
 *
 * For server actions, which receive no `Request`. `headers()` is async in
 * Next 16. A missing IP falls back to one shared bucket - the safe direction to
 * fail, since it makes the limit stricter rather than bypassable.
 */
export async function rateLimitByKey(
  name: string,
  options: Omit<RateLimitOptions, "key">,
): Promise<RateLimitResult> {
  const { headers } = await import("next/headers");
  const list = await headers();
  const forwarded = list.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || list.get("x-real-ip")?.trim() || "unknown";
  return consume(`${name}:${ip}`, { ...options, key: name });
}

/** Test seam: clear the in-memory buckets. */
export function resetRateLimits(): void {
  buckets.clear();
}
