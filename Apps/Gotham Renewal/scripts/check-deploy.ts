/**
 * Deployment readiness check.
 *
 * `check:database` verifies the database is in the state the code expects. This
 * verifies the ENVIRONMENT is. Both exist because their failures are silent:
 * a missing unique index or a localhost base URL does not crash anything, it
 * just quietly does the wrong thing in production.
 *
 * Run before a deploy, and again against the deployed environment:
 *
 *   npm run check:deploy                     # local env, warns about local-only values
 *   APP_BASE_URL=https://shop.example npm run check:deploy   # simulate production
 *
 * It exits non-zero only on things that are actually WRONG, not on things that
 * are merely configured for local development. That distinction is deliberate:
 * a gate that fails on every local run gets ignored, and an ignored gate is
 * worse than none.
 */
import "dotenv/config";

type Level = "error" | "warn" | "ok" | "info";

const findings: Array<{ level: Level; message: string }> = [];
const fail = (message: string) => findings.push({ level: "error", message });
const warn = (message: string) => findings.push({ level: "warn", message });
const ok = (message: string) => findings.push({ level: "ok", message });
const info = (message: string) => findings.push({ level: "info", message });

const e = process.env;

/** Is this environment claiming to be production? */
const looksProduction =
  (e.APP_BASE_URL ?? "").startsWith("https://") &&
  !(e.APP_BASE_URL ?? "").includes("localhost");

// --- 1. required variables --------------------------------------------------
const required = [
  "DATABASE_URL",
  "APP_BASE_URL",
  "ORDER_NUMBER_PREFIX",
  "ADMIN_PASSWORD",
  "ADMIN_SESSION_SECRET",
  "JOB_RUNNER_SECRET",
];
for (const key of required) {
  if (!e[key]) fail(`${key} is missing — the app will refuse to start without it`);
}
if (required.every((k) => e[k])) ok(`all ${required.length} required variables are set`);

// --- 2. the base URL --------------------------------------------------------
// This bakes into the "view order" link in every WhatsApp alert. Get it wrong and
// the owner taps a link to localhost and cannot reach the order.
const base = e.APP_BASE_URL ?? "";
if (!base) {
  // already reported above
} else if (base.includes("localhost")) {
  if (looksProduction) {
    warn("APP_BASE_URL is localhost but the environment looks like production");
  } else {
    info(`APP_BASE_URL is ${base} — fine for local development`);
  }
} else if (!base.startsWith("https://")) {
  fail(`APP_BASE_URL must be https in production, got ${base}`);
} else {
  ok(`APP_BASE_URL is ${base}`);
}
if (base.endsWith("/")) fail("APP_BASE_URL must not end with a trailing slash");

// --- 3. cron authentication -------------------------------------------------
// Not strictly required (the app starts without it) but its absence is the
// silent-failure mode: every scheduled run 401s and notifications never send.
// The app now logs an error at call time; this catches it before deploy.
if (!e.CRON_SECRET && !e.JOB_RUNNER_SECRET) {
  fail(
    "neither CRON_SECRET nor JOB_RUNNER_SECRET is set — every scheduled job will be refused, so notifications never send and the sweep never runs",
  );
} else if (!e.CRON_SECRET) {
  warn(
    "CRON_SECRET is not set. Vercel Cron sends this automatically once it exists on the project; without it the cron endpoints reject Vercel's calls unless JOB_RUNNER_SECRET happens to match.",
  );
} else {
  ok("cron authentication is configured (CRON_SECRET set)");
}

// --- 4. admin password strength --------------------------------------------
// A hash is the production form; plaintext is acceptable only for local work.
const adminPassword = e.ADMIN_PASSWORD ?? "";
if (adminPassword && !adminPassword.startsWith("scrypt$")) {
  if (looksProduction) {
    fail(
      "ADMIN_PASSWORD is plaintext in what looks like production. Generate a hash: npm run admin:hash -- \"your password\"",
    );
  } else {
    info("ADMIN_PASSWORD is plaintext — fine locally, use a scrypt hash for production");
  }
} else if (adminPassword.startsWith("scrypt$")) {
  ok("ADMIN_PASSWORD is a scrypt hash");
}

// --- 5. database connection shape -------------------------------------------
// Supabase requires two different strings; swapping them breaks either queries
// or migrations, and the failure is confusing rather than obvious.
const dbUrl = e.DATABASE_URL ?? "";
const directUrl = e.DIRECT_URL ?? "";
const isPooler = dbUrl.includes("pooler.supabase.com");

if (isPooler && dbUrl.includes(":5432")) {
  warn(
    "DATABASE_URL points at the Supabase SESSION pooler (5432). The app should use the transaction pooler (6543) — session mode holds a connection per client, which exhausts under serverless load.",
  );
} else if (isPooler && dbUrl.includes(":6543")) {
  ok("DATABASE_URL uses the transaction pooler (6543), correct for the app");
}

if (isPooler && !directUrl) {
  warn(
    "DIRECT_URL is not set. `prisma migrate deploy` will fall back to DATABASE_URL (the transaction pooler), which cannot run migrations.",
  );
} else if (directUrl.includes(":6543")) {
  fail(
    "DIRECT_URL points at the transaction pooler (6543). Migrations need the session/direct connection on 5432.",
  );
} else if (directUrl) {
  ok("DIRECT_URL is set for migrations");
}

// --- 6. optional provider groups --------------------------------------------
// Absent is fine — the features degrade rather than break. Present-but-partial is
// already a hard error in lib/env.ts; this mirrors it so the message is here too.
const groups: Record<string, string[]> = {
  WhatsApp: ["WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_BUSINESS_ACCOUNT_ID", "WHATSAPP_ACCESS_TOKEN"],
  Razorpay: ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"],
  Storage: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_STORAGE_BUCKET"],
  "Rate limiting": ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
};

for (const [name, keys] of Object.entries(groups)) {
  const present = keys.filter((k) => e[k]);
  if (present.length === 0) {
    info(`${name}: not configured (this feature is disabled, nothing breaks)`);
  } else if (present.length < keys.length) {
    fail(
      `${name}: partially configured — missing ${keys.filter((k) => !e[k]).join(", ")}. Set all or none.`,
    );
  } else {
    ok(`${name}: configured`);
  }
}

// --- 7. the razorpay key mode ----------------------------------------------
const keyId = e.RAZORPAY_KEY_ID ?? "";
if (keyId.startsWith("rzp_live_")) {
  info("Razorpay LIVE keys are in use — real money will move");
} else if (keyId.startsWith("rzp_test_")) {
  info("Razorpay TEST keys in use — no real money moves, which is correct before verification");
}

// --- 8. no secret may be browser-visible ------------------------------------
const leaked = Object.keys(e).filter(
  (k) => k.startsWith("NEXT_PUBLIC_") && /SECRET|TOKEN|PASSWORD|SERVICE_ROLE|API_KEY/i.test(k),
);
if (leaked.length > 0) {
  fail(`secrets exposed to the browser bundle: ${leaked.join(", ")}`);
} else {
  ok("no secret-bearing variable uses the NEXT_PUBLIC_ prefix");
}

// --- 9. placeholder detection -----------------------------------------------
if (e.ORDER_NOTIFICATION_NUMBER === "919999999999") {
  info("ORDER_NOTIFICATION_NUMBER is the placeholder — set the real number before launch");
}
if (keyId === "rzp_test_00000000000001") {
  info("RAZORPAY_KEY_ID is the placeholder used by the local checks — set real keys");
}

// --- report -----------------------------------------------------------------
const symbols: Record<Level, string> = { error: "FAIL", warn: "WARN", ok: "PASS", info: "INFO" };
const order: Level[] = ["error", "warn", "ok", "info"];
for (const level of order) {
  for (const f of findings.filter((x) => x.level === level)) {
    console.log(`${symbols[level]}  ${f.message}`);
  }
}

const errors = findings.filter((f) => f.level === "error").length;
const warnings = findings.filter((f) => f.level === "warn").length;

console.log(
  `\n${findings.filter((f) => f.level === "ok").length} passed, ${warnings} warning(s), ${errors} error(s).`,
);
if (errors > 0) {
  console.log("\nNOT ready to deploy — resolve the errors above.");
  process.exitCode = 1;
} else if (warnings > 0) {
  console.log("\nDeployable, but read the warnings.");
} else {
  console.log("\nEnvironment looks ready.");
}
