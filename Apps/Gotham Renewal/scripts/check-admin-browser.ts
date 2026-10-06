/**
 * Admin flow through a real browser: sign in, view the order, change its status.
 *
 * Complements `check-admin.ts` (which talks HTTP directly). This one exists
 * because a server action is not callable by a plain fetch - it needs the
 * Next-Action protocol and an encrypted action id, both of which the browser
 * supplies. So the only honest way to test the status-change button is to
 * click it.
 *
 * It also proves the session cookie is HttpOnly: a cookie the page's own
 * JavaScript cannot read is a cookie an XSS bug cannot steal.
 *
 * Run with `npm run dev` up, an order GR-9001 seeded, and ADMIN_PASSWORD in
 * .env as plaintext:
 *
 *   npm run check:admin-browser
 */
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { withUtcSession } from "../src/lib/db/connection";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const CHROME =
  process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEBUG_PORT = 9223;
const FIXTURE_ORDER_NUMBER = "GR-9001";

/**
 * The order this check drives. Created here rather than by a separate seed
 * script so the check is self-contained: a fixture that lives in another file
 * can be deleted by an unrelated cleanup and turn this into a mystery failure.
 */
async function seedFixtureOrder(prisma: PrismaClient): Promise<string> {
  const existing = await prisma.order.findFirst({
    where: { orderNumber: FIXTURE_ORDER_NUMBER },
  });
  if (existing) await prisma.order.delete({ where: { id: existing.id } });

  const order = await prisma.order.create({
    data: {
      orderNumber: FIXTURE_ORDER_NUMBER,
      customerName: "Browser Admin Test",
      customerPhone: "9876543210",
      address: "9 Test Lane, Somewhere",
      city: "Bengaluru",
      state: "Karnataka",
      pincode: "560001",
      subtotal: 45000,
      shipping: 0,
      total: 45000,
      paymentMethod: "COD",
      paymentStatus: "COD",
      orderStatus: "NEW",
      items: {
        create: [
          {
            productName: "Cold-Pressed Coconut Oil",
            quantity: 1,
            unitPrice: 45000,
            total: 45000,
          },
        ],
      },
    },
  });
  return order.id;
}

async function removeFixtureOrder(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.order.findFirst({
    where: { orderNumber: FIXTURE_ORDER_NUMBER },
  });
  if (existing) await prisma.order.delete({ where: { id: existing.id } });
}

type CdpMessage = { id?: number; result?: unknown; error?: { message: string } };

class Cdp {
  private nextId = 1;
  private pending = new Map<number, (message: CdpMessage) => void>();

  constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (typeof message.id === "number") {
        const resolve = this.pending.get(message.id);
        if (resolve) {
          this.pending.delete(message.id);
          resolve(message);
        }
      }
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("CDP socket error")));
    });
    return new Cdp(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const result = response.result as
      | { result?: { value?: T }; exceptionDetails?: { text?: string } }
      | undefined;
    if (result?.exceptionDetails) throw new Error(`page exception: ${result.exceptionDetails.text}`);
    return result?.result?.value as T;
  }

  close() {
    this.socket.close();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(cdp: Cdp, expression: string, description: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await cdp.evaluate<T>(expression);
      if (value) return value;
    } catch {
      // Navigation tears down the context; retry.
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function devtoolsUrl(): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const targets = (await response.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome not ready.
    }
    await sleep(300);
  }
  throw new Error("Chrome DevTools endpoint never became available");
}

async function fillNative(cdp: Cdp, selector: string, value: string): Promise<void> {
  await cdp.evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error("no element " + ${JSON.stringify(selector)});
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
    })()
  `);
}

async function main() {
  const password = process.env.ADMIN_PASSWORD ?? "";
  if (!password || password.startsWith("scrypt$")) {
    console.error("ADMIN_PASSWORD must be set as plaintext for this check.");
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: withUtcSession(process.env.DATABASE_URL!) }),
  });
  await seedFixtureOrder(prisma);
  console.log(`seeded fixture order ${FIXTURE_ORDER_NUMBER}\n`);

  const userDataDir = mkdtempSync(join(tmpdir(), "gotham-admin-"));
  let chrome: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  const results: Array<{ name: string; pass: boolean; detail: string }> = [];
  const check = (name: string, pass: boolean, detail = "") => {
    results.push({ name, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    chrome = spawn(
      CHROME,
      [
        "--headless=new",
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        BASE_URL,
      ],
      { stdio: "ignore" },
    );

    cdp = await Cdp.connect(await devtoolsUrl());
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");

    // --- 1. visiting /admin while signed out redirects to login -----------
    await cdp.send("Page.navigate", { url: `${BASE_URL}/admin` });
    const loginPath = await waitFor<string>(
      cdp,
      `location.pathname === "/admin/login" && location.pathname`,
      "a redirect to the login page",
    );
    check("signed-out /admin redirects to login", loginPath === "/admin/login", loginPath);

    // --- 2. sign in through the real form ---------------------------------
    await waitFor<string>(cdp, `document.querySelector("#password") && "ready"`, "the login form");
    await fillNative(cdp, "#password", password);
    await cdp.evaluate(`
      (() => {
        const form = document.querySelector("form");
        form.requestSubmit();
      })()
    `);

    const dashboardPath = await waitFor<string>(
      cdp,
      `location.pathname === "/admin" && location.pathname`,
      "the dashboard after login",
    );
    check("correct password signs in and lands on the dashboard", dashboardPath === "/admin");

    // --- 3. the session cookie is HttpOnly --------------------------------
    const cookieReport = await cdp.send("Network.getCookies", { urls: [BASE_URL] });
    const cookies = (cookieReport.result as { cookies?: Array<{ name: string; httpOnly: boolean; sameSite?: string; secure: boolean }> })
      ?.cookies ?? [];
    const session = cookies.find((c) => c.name === "gotham_admin");
    check("the session cookie exists", Boolean(session));
    check("the session cookie is HttpOnly", session?.httpOnly === true, `httpOnly=${session?.httpOnly}`);
    check(
      "the session cookie is SameSite=Lax",
      (session?.sameSite ?? "").toLowerCase() === "lax",
      `sameSite=${session?.sameSite}`,
    );

    const readable = await cdp.evaluate<boolean>(`document.cookie.includes("gotham_admin")`);
    check("page JavaScript cannot read the session cookie", readable === false);

    // --- 4. the order list shows the seeded order -------------------------
    await cdp.send("Page.navigate", { url: `${BASE_URL}/admin/orders` });
    await waitFor<string>(cdp, `document.body.textContent.includes("GR-9001") && "found"`, "GR-9001 in the list");
    check("the seeded order appears in the admin list", true);

    // --- 5. open the order and advance its status -------------------------
    await cdp.evaluate(`
      (() => {
        const link = [...document.querySelectorAll("a")].find(a => a.textContent.trim() === "GR-9001");
        if (link) link.click();
      })()
    `);
    await waitFor<string>(
      cdp,
      `document.body.textContent.includes("Browser Admin Test") && "on detail page"`,
      "the order detail page",
    );
    check("the order detail page renders the customer", true);

    // A click only does something once React has hydrated; before that the
    // button is in the server HTML with no handler attached. Click, check for
    // the effect, and click again if nothing happened. Retrying is safe here
    // because this control does not toggle - "Mark as confirmed" disappears once
    // the order is confirmed, so a second click cannot undo it.
    let updated = "";
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      updated = await cdp.evaluate<string>(
        `document.body.textContent.match(/Order updated to (\\w+)/) && RegExp.$1 || ""`,
      );
      if (updated) break;

      await cdp.evaluate(`
        (() => {
          const button = [...document.querySelectorAll("button")]
            .find(b => b.textContent.includes("Mark as confirmed"));
          if (button) button.click();
        })()
      `);
      await sleep(500);
    }

    check(
      "the order status changed through the UI",
      updated.toLowerCase() === "confirmed",
      updated ? `now ${updated}` : "no update observed",
    );

    // --- 6. the refund alert ------------------------------------------------
    // A CANCELLED + PAID order means the shop is holding money for an order it
    // will not fulfil. The dashboard must surface it rather than bury it, so the
    // check seeds that state and asserts the alert appears.
    const refundOrder = await prisma.order.create({
      data: {
        orderNumber: `LATE-${Date.now()}`,
        customerName: "Late Capture Test",
        customerPhone: "9876543210",
        address: "1 Late Road, Somewhere",
        city: "Bengaluru",
        state: "Karnataka",
        pincode: "560001",
        subtotal: 45000,
        shipping: 0,
        total: 45000,
        paymentMethod: "RAZORPAY",
        paymentStatus: "PAID",
        orderStatus: "CANCELLED",
      },
    });

    try {
      await cdp.send("Page.navigate", { url: `${BASE_URL}/admin` });
      const alertText = await waitFor<string>(
        cdp,
        `(() => { const el = document.querySelector('[role="alert"]'); return el && el.textContent; })()`,
        "the refund alert on the dashboard",
      );
      check(
        "a paid-but-cancelled order is surfaced as needing a refund",
        /refund/i.test(alertText),
        alertText.slice(0, 60).replace(/\s+/g, " "),
      );

      await cdp.send("Page.navigate", { url: `${BASE_URL}/admin/orders?filter=refund` });
      const refundListed = await waitFor<boolean>(
        cdp,
        `document.body.textContent.includes("Late Capture Test")`,
        "the refund order in the filtered list",
      );
      check("the refund filter lists the order", refundListed);
    } finally {
      await prisma.order.delete({ where: { id: refundOrder.id } }).catch(() => {});
    }

    // --- 7. sign out clears access ----------------------------------------
    const signedOut = await cdp.evaluate<boolean>(`
      (() => {
        const form = [...document.querySelectorAll("form")].find(f => f.textContent.includes("Sign out"));
        if (!form) return false;
        form.requestSubmit();
        return true;
      })()
    `);
    if (signedOut) {
      const backAtLogin = await waitFor<string>(
        cdp,
        `location.pathname === "/admin/login" && location.pathname`,
        "the login page after sign out",
      );
      check("signing out returns to the login page", backAtLogin === "/admin/login");

      const afterLogout = await fetch(`${BASE_URL}/admin`, { redirect: "manual" });
      check(
        "after sign out, /admin is protected again",
        afterLogout.status === 307 || afterLogout.status === 302 || afterLogout.status === 303,
        `status ${afterLogout.status}`,
      );
    }
  } finally {
    cdp?.close();
    chrome?.kill("SIGKILL");
    // Chrome keeps writing to its profile directory while shutting down, so
    // removing the tree immediately can fail with ENOTEMPTY and turn a passing
    // run into a failure. Wait, retry, and swallow.
    await sleep(500);
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A stray temp dir is not worth failing the run over.
    }
    await removeFixtureOrder(prisma);
    await prisma.$disconnect();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nFAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
