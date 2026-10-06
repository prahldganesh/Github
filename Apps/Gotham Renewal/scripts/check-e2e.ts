/**
 * End-to-end checkout, driven through a real browser.
 *
 * Why this exists: every other check in the project talks to the server
 * directly. This one is the only check that exercises the parts that only exist
 * in a browser - React rendering, the cart context, and localStorage - which is
 * exactly where a wiring bug would hide (a button that renders but calls
 * nothing, a cart that never persists).
 *
 * It drives Google Chrome over the DevTools Protocol using Node's built-in
 * `WebSocket`, so it adds no dependency. Run with:
 *
 *   npm run check:e2e        (requires `npm run dev` already running)
 *
 * NOT part of `npm test`, which must stay fast and browser-free.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const CHROME =
  process.env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEBUG_PORT = 9222;

type CdpMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
};

/** Minimal CDP client: one socket, request/response by id. */
class Cdp {
  private nextId = 1;
  private pending = new Map<number, (message: CdpMessage) => void>();
  private socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;
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

  /** Evaluate an expression in the page and return its JSON value. */
  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const result = response.result as
      | { result?: { value?: T }; exceptionDetails?: { text?: string } }
      | undefined;
    if (result?.exceptionDetails) {
      throw new Error(`page exception: ${result.exceptionDetails.text}`);
    }
    return result?.result?.value as T;
  }

  close(): void {
    this.socket.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll a page expression until it returns truthy, or time out.
 *
 * Swallows evaluation errors: a `Page.navigate` tears down the JS execution
 * context, so an evaluate issued mid-navigation fails transiently with
 * "Uncaught". That is expected during a page change, not a test failure.
 */
async function waitFor<T>(
  cdp: Cdp,
  expression: string,
  description: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await cdp.evaluate<T>(expression);
      if (value) return value;
    } catch {
      // Context destroyed by navigation, or the node is not there yet.
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${description}`);
}

/**
 * Set an input's value the way a user would, so React registers the change.
 *
 * Assigning `el.value` directly does not notify React: React installs its own
 * value tracker on the DOM node, and a plain assignment is seen as "no change".
 * Calling the native prototype setter bypasses that tracker, and the dispatched
 * `input` event then makes React re-read the value. This is the standard way to
 * drive a controlled React input from outside.
 */
async function fillField(cdp: Cdp, id: string, value: string): Promise<void> {
  await cdp.evaluate(`
    (() => {
      const el = document.querySelector("#${id}");
      if (!el) throw new Error("no element #${id}");
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
    })()
  `);
}

async function devtoolsUrl(): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const targets = (await response.json()) as Array<{
        type: string;
        webSocketDebuggerUrl?: string;
      }>;
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome not up yet.
    }
    await sleep(300);
  }
  throw new Error("Chrome DevTools endpoint never became available");
}

async function main(): Promise<void> {
  const userDataDir = mkdtempSync(join(tmpdir(), "gotham-e2e-"));
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

    const orderNumber = await runCheckout(cdp);
    console.log(`\nPASS: browser checkout completed, order ${orderNumber} placed.`);
  } finally {
    cdp?.close();
    chrome?.kill("SIGKILL");
    // Chrome keeps writing to its profile directory while shutting down, so
    // removing the tree immediately can fail with ENOTEMPTY. Wait, retry, and
    // never let a leftover temp directory masquerade as a test failure - that is
    // exactly what happened here once.
    await sleep(500);
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A stray temp dir is not worth failing the run over.
    }
  }
}

async function runCheckout(cdp: Cdp): Promise<string> {
  // --- 1. find a product to buy --------------------------------------------
  // The first product in the catalogue, discovered rather than hardcoded. A
  // hardcoded slug couples this check to the seed data, so any catalogue change
  // breaks the test for no real reason - which is exactly what happened when the
  // shop's real products replaced the demo ones.
  await cdp.send("Page.navigate", { url: `${BASE_URL}/products` });
  const productHref = await waitFor<string>(
    cdp,
    `(() => {
       const link = [...document.querySelectorAll('a[href^="/products/"]')]
         .map(a => a.getAttribute("href"))
         .find(h => h && h.length > "/products/".length);
       return link || "";
     })()`,
    "a product link in the catalogue",
  );

  await cdp.send("Page.navigate", { url: `${BASE_URL}${productHref}` });
  const heading = await waitFor<string>(
    cdp,
    `document.querySelector("h1") && document.querySelector("h1").textContent`,
    "the product heading",
  );
  console.log(`1. product page loaded: "${heading}" (${productHref})`);

  // --- 2. add to cart ------------------------------------------------------
  // A click only works once React has hydrated and attached its handlers;
  // before that the button exists in the HTML but does nothing. So click, then
  // check for the effect, and only click again if nothing happened. Checking
  // between clicks is what stops a retry from adding the line twice.
  let cart: { lines: Array<{ name: string; quantity: number }> } = { lines: [] };

  for (let attempt = 1; attempt <= 15; attempt++) {
    await cdp.evaluate(`
      (() => {
        const select = document.querySelector('select[aria-label="Quantity"]');
        if (select) {
          const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
          setter.call(select, "2");
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
        const button = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Add to cart");
        if (button) button.click();
      })()
    `);

    await sleep(400);
    const stored = await cdp.evaluate<string | null>(
      `window.localStorage.getItem("gotham.cart.v1")`,
    );
    if (stored) {
      const parsed = JSON.parse(stored) as { lines: Array<{ name: string; quantity: number }> };
      if (parsed.lines.length > 0) {
        cart = parsed;
        break;
      }
    }
  }

  if (cart.lines.length === 0) {
    throw new Error("Add to cart never took effect - React may not have hydrated");
  }
  console.log(`2. added to cart, localStorage: ${JSON.stringify(cart.lines)}`);
  if (cart.lines.length !== 1 || cart.lines[0].quantity !== 2) {
    throw new Error(`expected one line of quantity 2, got ${JSON.stringify(cart.lines)}`);
  }

  // --- 3. cart page --------------------------------------------------------
  await cdp.send("Page.navigate", { url: `${BASE_URL}/cart` });
  const cartSubtotal = await waitFor<string>(
    cdp,
    `(() => { const m = document.body.textContent.match(/Subtotal\\s*(₹[\\d.,]+)/); return m && m[1]; })()`,
    "the cart subtotal",
  );
  console.log(`3. cart page subtotal: ${cartSubtotal}`);

  // --- 4. checkout page ----------------------------------------------------
  await cdp.send("Page.navigate", { url: `${BASE_URL}/checkout` });
  await waitFor<string>(cdp, `document.querySelector("input#name") && "ready"`, "the checkout form");

  await fillField(cdp, "name", "E2E Browser Test");
  await fillField(cdp, "phone", "9876543210");
  await fillField(cdp, "address", "12 MG Road, Near Temple");
  await fillField(cdp, "city", "Bengaluru");
  await fillField(cdp, "state", "Karnataka");
  await fillField(cdp, "pincode", "560001");
  console.log("3b. filled the delivery form");;

  // --- 5. submit -----------------------------------------------------------
  const submitted = await cdp.evaluate<boolean>(`
    (() => {
      const button = [...document.querySelectorAll("button")].find(b => b.textContent.includes("Place order"));
      if (!button) return false;
      button.click();
      return true;
    })()
  `);
  if (!submitted) throw new Error("could not find the Place order button");

  // --- 6. confirmation -----------------------------------------------------
  const orderNumber = await waitFor<string>(
    cdp,
    `(() => {
       if (!location.pathname.startsWith("/order-success/")) return false;
       const m = document.body.textContent.match(/GR-\\d+/);
       return m && m[0];
     })()`,
    "the order confirmation page",
  );
  console.log(`4. redirected to ${await cdp.evaluate<string>("location.pathname")}`);
  console.log(`5. confirmation shows order ${orderNumber}`);

  // --- 7. cart cleared -----------------------------------------------------
  const after = await cdp.evaluate<string>(`window.localStorage.getItem("gotham.cart.v1")`);
  const remaining = (JSON.parse(after ?? '{"lines":[]}') as { lines: unknown[] }).lines.length;
  console.log(`6. cart after checkout: ${remaining} line(s)`);
  if (remaining !== 0) throw new Error(`cart was not cleared, ${remaining} lines remain`);

  return orderNumber;
}

main().catch((error) => {
  console.error(`\nFAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
