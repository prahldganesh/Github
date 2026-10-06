/**
 * Admin product management, driven through a real browser.
 *
 * Server actions are not callable by a plain fetch - they need Next's encrypted
 * action id and protocol - so the only honest test of "can the owner add a
 * product and disable it" is to click the buttons.
 *
 * It also proves the two properties a unit test cannot: that creating a product
 * through the form stores PAISE (not the rupees the admin typed), and that
 * disabling hides it from the storefront while the row survives.
 *
 * Run with `npm run dev` up and ADMIN_PASSWORD plaintext:
 *   npm run check:products-browser
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
const DEBUG_PORT = 9224;
const SLUG = "browser-product-check";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: withUtcSession(process.env.DATABASE_URL!) }),
});

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
      | {
          result?: { value?: T };
          exceptionDetails?: {
            text?: string;
            exception?: { description?: string; value?: unknown };
          };
        }
      | undefined;
    if (result?.exceptionDetails) {
      // Surface the real message. CDP's `text` is often just "Uncaught", which
      // is useless for debugging; `exception.description` carries the stack.
      const detail =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "unknown page error";
      throw new Error(`page exception: ${detail}`);
    }
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
      // Navigation tears down the execution context; retry.
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

/**
 * Type a value into a controlled input, the way a user would.
 *
 * Earlier versions set `el.value` through the native prototype setter to defeat
 * React's value tracker. That works, but it is fragile (a wrong receiver throws
 * "Illegal invocation") and it bypasses the very event path we want to exercise.
 * Real key input is simpler and truer: focus the field, select any existing
 * text, then let Chrome insert the characters. React sees genuine input events.
 */
/**
 * Set a controlled input the way a user would, so React registers the change.
 *
 * This is the same helper that `check-admin-browser.ts` uses, and it is the
 * standard technique for driving a controlled React input from outside:
 * assigning `el.value` directly does not notify React (it installs its own value
 * tracker and sees the assignment as "no change"), so we call the NATIVE
 * prototype setter to bypass the tracker and then dispatch an `input` event for
 * React to read the new value.
 *
 * It replaces the value wholesale, which is why there is no separate clear step.
 */
async function fill(cdp: Cdp, selector: string, value: string): Promise<void> {
  const report = await cdp.evaluate<string>(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return "NO ELEMENT";
      const tag = el.tagName;
      const type = el.getAttribute("type") || "";
      try {
        const proto =
          tag === "TEXTAREA" ? HTMLTextAreaElement.prototype
          : tag === "SELECT" ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
        if (!descriptor || !descriptor.set) return "NO SETTER for " + tag + "/" + type;
        descriptor.set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return "OK";
      } catch (error) {
        return "THREW: " + tag + "/" + type + " :: " + (error && error.message);
      }
    })()
  `);
  if (report !== "OK") {
    throw new Error(`fill(${selector}) failed: ${report}`);
  }
}

async function cleanup() {
  const existing = await prisma.product.findUnique({ where: { slug: SLUG } });
  if (existing) await prisma.product.delete({ where: { id: existing.id } });
}

async function main() {
  const password = process.env.ADMIN_PASSWORD ?? "";
  if (!password || password.startsWith("scrypt$")) {
    console.error("ADMIN_PASSWORD must be plaintext for this check.");
    process.exitCode = 1;
    return;
  }

  const results: Array<{ name: string; pass: boolean; detail: string }> = [];
  const check = (name: string, pass: boolean, detail = "") => {
    results.push({ name, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  await cleanup();

  const userDataDir = mkdtempSync(join(tmpdir(), "gotham-products-"));
  let chrome: ChildProcess | undefined;
  let cdp: Cdp | undefined;

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

    // --- sign in -----------------------------------------------------------
    await cdp.send("Page.navigate", { url: `${BASE_URL}/admin/login` });
    await waitFor<string>(cdp, `document.querySelector("#password") && "ready"`, "the login form");
    await fill(cdp, "#password", password);
    await cdp.evaluate(`document.querySelector("form").requestSubmit()`);
    await waitFor<string>(cdp, `location.pathname === "/admin" && "on"`, "the dashboard");
    check("signed in", true);

    // --- the products list is reachable -------------------------------------
    await cdp.send("Page.navigate", { url: `${BASE_URL}/admin/products` });
    await waitFor<string>(
      cdp,
      `document.body.textContent.includes("New product") && "ok"`,
      "the products page",
    );
    check("the products admin page loads", true);

    // --- create a product through the form ----------------------------------
    await cdp.send("Page.navigate", { url: `${BASE_URL}/admin/products/new` });
    await waitFor<string>(cdp, `document.querySelector('[name="name"]') && "ready"`, "the create form");

    await fill(cdp, 'input[name="name"]', "Browser Check Product");
    await fill(cdp, 'input[name="slug"]', SLUG);
    // Scope to the form. A bare `[name="description"]` also matches the
    // document's <meta name="description">, whose element has no value setter -
    // that ambiguity produced a confusing "Illegal invocation" during
    // development of this check.
    await fill(cdp, 'form textarea[name="description"]', "Created by the browser check.");
    // Typed in RUPEES, exactly as an admin would.
    await fill(cdp, 'input[name="priceRupees"]', "450.50");
    await fill(cdp, 'input[name="stock"]', "7");

    // Submit by requesting the form directly rather than clicking the button.
    // Clicking is a second thing that can go wrong (the text match, the hit
    // target); `requestSubmit()` is what a click does anyway, and it bypasses
    // neither validation nor the action.
    // Submit the form that CONTAINS the product fields. `querySelector("form")`
    // would grab the admin header's "Sign out" form, which is the first in the
    // document - that mistake silently posted the logout action instead.

    const submitted = await cdp.evaluate<boolean>(`
      (() => {
        const form = document.querySelector('[name="slug"]')?.closest("form");
        if (!form) return false;
        form.requestSubmit();
        return true;
      })()
    `);
    if (!submitted) throw new Error("could not submit the create form");

    await waitFor<string>(
      cdp,
      `document.body.textContent.includes("Browser Check Product") && "saved"`,
      "the product to be saved",
    );
    check("the product was created through the form", true);

    // --- the money rule: rupees typed, paise stored -------------------------
    const stored = await prisma.product.findUnique({ where: { slug: SLUG } });
    check(
      "450.50 rupees was stored as 45050 paise",
      stored?.price === 45050,
      `price=${stored?.price}`,
    );
    check("stock was stored", stored?.stock === 7, `stock=${stored?.stock}`);

    // --- it appears on the storefront ---------------------------------------
    const storefront = await fetch(`${BASE_URL}/products/${SLUG}`, { redirect: "manual" });
    check(
      "the new product is visible on the storefront",
      storefront.status === 200,
      `status ${storefront.status}`,
    );

    // --- disable it via the form --------------------------------------------
    await cdp.send("Page.navigate", { url: `${BASE_URL}/admin/products/${stored?.id}` });
    await waitFor<string>(
      cdp,
      `document.body.textContent.includes("Disable") && "ok"`,
      "the edit page with a Disable action",
    );
    await cdp.evaluate(`
      (() => {
        // Four forms on the page, two of which mention "active": the edit form
        // (checkbox + "Save changes") and the enable/disable form (hidden field
        // + "Disable product"). Selecting by the field alone matched the edit
        // form and clicked Save - which re-checked the box and left the product
        // active. Selecting by the button text is unambiguous.
        const button = [...document.querySelectorAll("button[type=submit]")]
          .find(b => /^(disable|enable) product$/i.test(b.textContent.trim()));
        if (!button) throw new Error("no enable/disable button");
        button.click();
      })()
    `);

    // A click only does something once React has hydrated - before that the
    // button exists in the server HTML but has no handler.
    //
    // The retry must NOT be naive. After a successful disable the button's label
    // flips to "Enable product", so blindly clicking again would RE-ENABLE the
    // product. That is exactly what happened in the first version of this check:
    // it reported "disable failed" when in fact the app had toggled it back on.
    // So the loop only clicks while the label still reads "Disable", and stops
    // the moment the database agrees.
    const deadline = Date.now() + 20_000;
    let disabled = false;
    while (Date.now() < deadline) {
      const row = await prisma.product.findUnique({ where: { slug: SLUG } });
      if (row?.active === false) {
        disabled = true;
        break;
      }

      await cdp.evaluate(`
        (() => {
          const button = [...document.querySelectorAll("button[type=submit]")]
            .find(b => b.textContent.trim().toLowerCase() === "disable product");
          if (button) button.click();
        })()
      `);
      await sleep(500);
    }
    check("disabling through the form worked", disabled);

    // --- disabled means gone from the storefront, but not deleted -----------
    const afterStorefront = await fetch(`${BASE_URL}/products/${SLUG}`, { redirect: "manual" });
    check(
      "the disabled product 404s on the storefront",
      afterStorefront.status === 404,
      `status ${afterStorefront.status}`,
    );
    const stillThere = await prisma.product.findUnique({ where: { slug: SLUG } });
    check("the product row still exists (disabled, not deleted)", stillThere !== null);

    // --- stock edit ----------------------------------------------------------
    await cdp.send("Page.navigate", { url: `${BASE_URL}/admin/products/${stored?.id}` });
    await waitFor<string>(cdp, `document.body.textContent.includes("Stock") && "ok"`, "the stock form");

    await fill(cdp, 'form input[name="stock"]', "25");
    await cdp.evaluate(`
      (() => {
        const input = document.querySelector('form input[name="stock"]');
        if (!input) throw new Error("no stock input");
        const form = input.closest("form");
        if (!form) throw new Error("stock input is not in a form");
        form.requestSubmit();
        return true;
      })()
    `);

    {
      const deadline2 = Date.now() + 15_000;
      let stock = -1;
      while (Date.now() < deadline2) {
        stock = (await prisma.product.findUnique({ where: { slug: SLUG } }))?.stock ?? -1;
        if (stock === 25) break;
        await sleep(300);
      }
      check("stock can be changed through the form", stock === 25, `stock=${stock}`);
    }
  } finally {
    cdp?.close();
    chrome?.kill("SIGKILL");
    // Chrome writes to its profile directory as it shuts down, so removing the
    // tree immediately can fail with ENOTEMPTY. Wait briefly, and never let a
    // cleanup failure mask the real test result.
    await sleep(500);
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A leftover temp directory is not worth failing the check over.
    }
    await cleanup();
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
