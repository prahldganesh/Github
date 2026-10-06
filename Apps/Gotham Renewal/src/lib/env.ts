/**
 * Environment variable validation.
 *
 * This module is the single source of truth for configuration. It is imported
 * by `lib/db` and by anything that talks to a provider, and it carries
 * `server-only` so a Client Component importing it fails the build instead of
 * shipping secrets to the browser.
 *
 * Optional services (WhatsApp, Razorpay) are validated as optional groups:
 * absent variables are allowed, but a *partially* configured service is a hard
 * error - it is better to refuse to start than to send a payment webhook to a
 * provider whose secret is missing.
 */
import "server-only";
import { z } from "zod";

const requiredString = z.string().min(1, "must not be empty");

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    DATABASE_URL: z
      .string()
      .min(1, "DATABASE_URL is required")
      .refine((v) => v.startsWith("postgres"), "must be a postgres:// connection string"),

    APP_BASE_URL: z
      .string()
      .min(1)
      .refine((v) => /^https?:\/\//.test(v), "must start with http:// or https://")
      .refine((v) => !v.endsWith("/"), "must not have a trailing slash"),

    ORDER_NUMBER_PREFIX: z
      .string()
      .regex(/^[A-Z]{1,4}$/, "1-4 uppercase letters, e.g. GR"),

    // Money in paise. Kept as strings on the way in so a value like "5000.5"
    // is rejected rather than silently truncated by Number().
    SHIPPING_FEE_PAISE: z.coerce.number().int().min(0).default(0),
    FREE_SHIPPING_THRESHOLD_PAISE: z.coerce.number().int().min(0).default(0),

    ADMIN_PASSWORD: z
      .string()
      .min(8, "use at least 8 characters")
      // Either a plaintext password (bootstrap) or a scrypt hash produced by
      // `npm run admin:hash`. Detected by the "scrypt$" prefix.
      .describe("plaintext password, or a scrypt$... hash"),
    ADMIN_SESSION_SECRET: requiredString.min(32, "use 32+ random bytes, see .env.example"),

    // Bearer token a scheduler presents to POST /api/jobs/notifications. An
    // unauthenticated endpoint that sends WhatsApp messages could be looped by
    // anyone to burn the message quota, so it is required, not optional.
    JOB_RUNNER_SECRET: requiredString.min(16, "use 16+ random bytes, see .env.example"),

    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

    // --- Optional provider groups -----------------------------------------
    // All absent  -> the feature is disabled (Phase 9 / 10 are not wired yet).
    // Some absent -> hard failure, see the superRefine below.
    ORDER_NOTIFICATION_NUMBER: z
      .string()
      .regex(/^\d{10,15}$/, "E.164 digits only, e.g. 919876543210")
      .optional()
      .or(z.literal("")),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
    WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional(),
    WHATSAPP_ACCESS_TOKEN: z.string().optional(),
    META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/, "e.g. v21.0").default("v21.0"),

    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const groups = {
      WhatsApp: [
        "WHATSAPP_PHONE_NUMBER_ID",
        "WHATSAPP_BUSINESS_ACCOUNT_ID",
        "WHATSAPP_ACCESS_TOKEN",
      ],
      Razorpay: ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"],
    } as const;

    for (const [service, keys] of Object.entries(groups)) {
      const present = keys.filter((key) => {
        const raw = value[key as keyof typeof value];
        return typeof raw === "string" && raw.length > 0;
      });
      if (present.length > 0 && present.length < keys.length) {
        const missing = keys.filter((k) => !present.includes(k));
        ctx.addIssue({
          code: "custom",
          message: `${service} is partially configured. Missing: ${missing.join(", ")}. Set all of them or none.`,
        });
      }
    }
  });

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/**
 * Parse and cache the environment. Throws with every problem at once so you do
 * not fix a misconfiguration one variable per restart.
 */
export function env(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  cached = parsed.data;
  return cached;
}

/** True when the optional WhatsApp group is fully configured. */
export function whatsappConfigured(): boolean {
  const e = env();
  return Boolean(
    e.WHATSAPP_PHONE_NUMBER_ID && e.WHATSAPP_BUSINESS_ACCOUNT_ID && e.WHATSAPP_ACCESS_TOKEN,
  );
}

/** True when the optional Razorpay group is fully configured. */
export function razorpayConfigured(): boolean {
  const e = env();
  return Boolean(e.RAZORPAY_KEY_ID && e.RAZORPAY_KEY_SECRET && e.RAZORPAY_WEBHOOK_SECRET);
}
