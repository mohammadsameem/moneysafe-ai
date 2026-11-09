/**
 * Browser QA: drives a REAL headless Edge/Chrome (Chrome DevTools Protocol, no extra dependency)
 * through the signed-in app at a phone width (375 px) and a desktop width (1280 px).
 *
 *   npm run qa:browser            (the dev server must be running, DEMO_MODE=true)
 *
 * It signs in through the real login form, clicks real buttons (Start demo, Restart my demo,
 * Approve, Simulate outcome, Approve change, the Reset dialog, the mobile tabs), and audits every
 * page for horizontal overflow, the right navigation for the width, tap-target size and console
 * errors (a hydration mismatch shows up as one). Full-page screenshots go to .qa/screens/.
 *
 * It RESETS THE DEMO (that is one of the things it tests) and cleans up its own session afterwards,
 * so run it when nobody else is using the database. Credentials are read from the environment and
 * are never printed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedId } from "../../src/seed/ids";
import { BASE, check, cleanup, closeDb, finish, getSql, guardLocalOnly, info, noteFailure, sleep, waitForResetCooldown } from "./common";

const OUT = join(process.cwd(), ".qa", "screens");
const PORT = Number(process.env.QA_CDP_PORT ?? 9333);

// ---------------------------------------------------------------------------------------------------
// A tiny Chrome DevTools Protocol client
// ---------------------------------------------------------------------------------------------------
type Params = Record<string, unknown>;

class Cdp {
  private id = 0;
  private waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private listeners: Array<(method: string, params: Params) => void> = [];

  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Params };
      if (msg.id !== undefined) {
        const w = this.waiting.get(msg.id);
        if (!w) return;
        this.waiting.delete(msg.id);
        if (msg.error) w.reject(new Error(msg.error.message));
        else w.resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg.method, msg.params ?? {});
      }
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("could not connect to the browser")));
    });
    return new Cdp(ws);
  }

  send<T = Params>(method: string, params: Params = {}): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  onEvent(fn: (method: string, params: Params) => void): void {
    this.listeners.push(fn);
  }

  close(): void {
    this.ws.close();
  }
}

// ---------------------------------------------------------------------------------------------------
// Page helper
// ---------------------------------------------------------------------------------------------------
/** Browser-side helper: the first VISIBLE element matching a selector (and, optionally, containing some text). */
const FIND = `
const find = (sel, text) => {
  const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  const els = Array.from(document.querySelectorAll(sel)).filter((e) => {
    const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  });
  if (!text) return els[0] || null;
  return els.find((e) => norm(e.textContent).includes(text) || norm(e.getAttribute('aria-label')) === text) || null;
};`;

interface Viewport {
  name: "mobile" | "tablet" | "desktop";
  width: number;
  height: number;
}

class Page {
  consoleErrors: string[] = [];
  private inflight = 0;
  private viewport: Viewport = { name: "desktop", width: 1280, height: 800 };

  constructor(private cdp: Cdp) {
    cdp.onEvent((method, params) => {
      if (method === "Network.requestWillBeSent") this.inflight++;
      else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") this.inflight = Math.max(0, this.inflight - 1);
      else if (method === "Runtime.exceptionThrown") {
        const d = (params.exceptionDetails ?? {}) as { text?: string; exception?: { description?: string } };
        this.consoleErrors.push(`exception: ${(d.exception?.description ?? d.text ?? "").split("\n")[0]}`);
      } else if (method === "Runtime.consoleAPICalled" && params.type === "error") {
        const args = (params.args ?? []) as Array<{ value?: unknown; description?: string }>;
        this.consoleErrors.push(`console.error: ${args.map((a) => String(a.value ?? a.description ?? "")).join(" ").slice(0, 200)}`);
      } else if (method === "Log.entryAdded") {
        const e = (params.entry ?? {}) as { level?: string; text?: string; url?: string };
        if (e.level === "error") this.consoleErrors.push(`log: ${e.text ?? ""} ${e.url ?? ""}`.slice(0, 200));
      }
    });
  }

  async init(): Promise<void> {
    for (const domain of ["Page", "Runtime", "Network", "Log"]) await this.cdp.send(`${domain}.enable`);
  }

  async setViewport(v: Viewport): Promise<void> {
    this.viewport = v;
    await this.cdp.send("Emulation.setDeviceMetricsOverride", { width: v.width, height: v.height, deviceScaleFactor: 1, mobile: v.name === "mobile" });
    await this.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: v.name === "mobile" });
  }

  async eval<T>(expression: string): Promise<T> {
    const r = await this.cdp.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(`page script failed: ${(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split("\n")[0]}`);
    return r.result.value as T;
  }

  /** Wait until the network has been quiet for a moment, then give React a beat to hydrate. */
  async settle(maxMs = 12_000): Promise<void> {
    const end = Date.now() + maxMs;
    let quietSince = Date.now();
    while (Date.now() < end) {
      if (this.inflight > 0) quietSince = Date.now();
      else if (Date.now() - quietSince > 700) break;
      await sleep(100);
    }
    await this.eval<void>("new Promise((r) => requestAnimationFrame(() => setTimeout(r, 250)))");
  }

  async goto(path: string): Promise<void> {
    let loaded: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (loaded = resolve));
    this.cdp.onEvent((method) => {
      if (method === "Page.loadEventFired") loaded();
    });
    await this.cdp.send("Page.navigate", { url: `${BASE}${path}` });
    await Promise.race([done, sleep(45_000)]);
    await this.settle();
  }

  async waitFor(expression: string, timeoutMs = 15_000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        if (await this.eval<boolean>(`(() => { ${FIND} return Boolean(${expression}); })()`)) return true;
      } catch {
        /* the page is navigating; try again */
      }
      await sleep(150);
    }
    return false;
  }

  /** A real mouse click at the centre of the first visible matching element. */
  async click(selector: string, text?: string): Promise<boolean> {
    const pos = await this.eval<{ x: number; y: number } | null>(
      `(() => { ${FIND} const el = find(${JSON.stringify(selector)}, ${JSON.stringify(text ?? "")}); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    if (!pos) return false;
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y });
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    return true;
  }

  async type(selector: string, text: string): Promise<boolean> {
    const ok = await this.eval<boolean>(`(() => { ${FIND} const el = find(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return true; })()`);
    if (ok) await this.cdp.send("Input.insertText", { text });
    return ok;
  }

  pathname = (): Promise<string> => this.eval<string>("location.pathname");
  text = (): Promise<string> => this.eval<string>("document.body.innerText");
  toasts = (): Promise<string> => this.eval<string>(`(document.querySelector('[aria-label="Notifications"]') || {}).innerText || ''`);

  async shot(name: string): Promise<void> {
    mkdirSync(OUT, { recursive: true });
    const m = await this.cdp.send<{ cssContentSize?: { height: number }; contentSize: { height: number } }>("Page.getLayoutMetrics");
    const height = Math.min(Math.ceil((m.cssContentSize ?? m.contentSize).height), 7000);
    const r = await this.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: this.viewport.width, height, scale: 1 } });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, "base64"));
  }
}

// ---------------------------------------------------------------------------------------------------
// Layout audit, run inside the page
// ---------------------------------------------------------------------------------------------------
interface Audit {
  vw: number;
  overflowPx: number;
  offenders: string[];
  smallTargets: string[];
  h1: string;
  sidebar: boolean;
  bottomNav: boolean;
  mobileHeader: boolean;
  bottomNavHeight: number;
  mainPaddingBottom: number;
  currentTabs: number;
}

const AUDIT = `(() => {
  ${FIND}
  const vw = document.documentElement.clientWidth;
  const shown = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none'; };
  // Content inside a sideways-scrolling container is fine, UNLESS it is absolutely positioned and the container is not
  // positioned: then the container does not clip it and it widens the page (this is how sr-only text broke the layout).
  const inScrollable = (el) => { const abs = getComputedStyle(el).position === 'absolute'; let p = el.parentElement; while (p && p !== document.body) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth) return !(abs && s.position === 'static'); p = p.parentElement; } return false; };
  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || el.closest('dialog:not([open])') || getComputedStyle(el).position === 'fixed') continue;
    if ((r.right > vw + 1 || r.left < -1) && !inScrollable(el)) offenders.push(el.tagName.toLowerCase() + '.' + String(el.className || '').split(' ').slice(0, 3).join('.') + ' [' + Math.round(r.left) + ',' + Math.round(r.right) + ']');
  }
  const small = Array.from(document.querySelectorAll('main button, main summary, main a.rounded-md, header button, nav a, dialog[open] button'))
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 40 && !e.closest('[data-compact]') && !e.hasAttribute('data-compact'); })
    .map((e) => (e.textContent || e.getAttribute('aria-label') || e.tagName).trim().replace(/\\s+/g, ' ').slice(0, 30) + ' (' + Math.round(e.getBoundingClientRect().height) + 'px)');
  const side = document.querySelector('aside');
  const bottom = document.querySelector('nav[aria-label="Main"].fixed');
  const header = document.querySelector('header.sticky');
  const main = document.querySelector('main');
  return {
    vw,
    overflowPx: document.documentElement.scrollWidth - vw,
    offenders: offenders.slice(0, 6),
    smallTargets: small.slice(0, 8),
    h1: ((document.querySelector('h1') || {}).textContent || '').trim(),
    sidebar: shown(side),
    bottomNav: shown(bottom),
    mobileHeader: shown(header),
    bottomNavHeight: bottom ? Math.round(bottom.getBoundingClientRect().height) : 0,
    mainPaddingBottom: main ? parseFloat(getComputedStyle(main).paddingBottom) : 0,
    currentTabs: bottom ? bottom.querySelectorAll('[aria-current="page"]').length : 0,
  };
})()`;

// ---------------------------------------------------------------------------------------------------
// Browser launch
// ---------------------------------------------------------------------------------------------------
function findBrowser(): string | null {
  const candidates = [
    process.env.QA_BROWSER,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((c): c is string => Boolean(c) && existsSync(c as string)) ?? null;
}

async function launch(browser: string, profile: string): Promise<ChildProcess> {
  const child = spawn(
    browser,
    [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--mute-audio", "--disable-extensions", "about:blank"],
    { stdio: "ignore", windowsHide: true },
  );
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return child;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  child.kill();
  throw new Error("the browser did not start");
}

async function openPage(): Promise<{ cdp: Cdp; page: Page }> {
  const url = `http://127.0.0.1:${PORT}/json/new?about:blank`;
  let res = await fetch(url, { method: "PUT" });
  if (!res.ok) res = await fetch(url);
  const target = (await res.json()) as { webSocketDebuggerUrl: string };
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  const page = new Page(cdp);
  await page.init();
  return { cdp, page };
}

// ---------------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------------
const MOBILE: Viewport = { name: "mobile", width: 375, height: 812 };
const TABLET: Viewport = { name: "tablet", width: 768, height: 1024 }; // the first width with the sidebar (md)
const DESKTOP: Viewport = { name: "desktop", width: 1280, height: 800 };

/** Load a page at the current viewport and audit its layout. */
async function auditPage(page: Page, v: Viewport, label: string, path: string, shotName: string, expectH1?: RegExp): Promise<void> {
  page.consoleErrors.length = 0;
  await page.goto(path);
  const a = await page.eval<Audit>(AUDIT);
  const where = `${label} @ ${v.width}px`;
  check(`${where}: renders a heading${expectH1 ? ` matching ${expectH1}` : ""}`, a.h1 !== "" && (!expectH1 || expectH1.test(a.h1)), a.h1);
  check(`${where}: no horizontal scrolling (page ${a.overflowPx <= 0 ? "fits" : `overflows by ${a.overflowPx}px`})`, a.overflowPx <= 0 && a.offenders.length === 0, a.offenders.join(" | "));
  if (v.name === "mobile") {
    check(`${where}: bottom tab bar + top bar shown, sidebar hidden`, a.bottomNav && a.mobileHeader && !a.sidebar);
    check(`${where}: content clears the bottom bar (padding ${a.mainPaddingBottom}px >= bar ${a.bottomNavHeight}px)`, a.mainPaddingBottom >= a.bottomNavHeight);
    check(`${where}: buttons and tabs are at least 40 px tall`, a.smallTargets.length === 0, a.smallTargets.join(", "));
  } else {
    check(`${where}: sidebar shown, bottom bar and top bar hidden`, a.sidebar && !a.bottomNav && !a.mobileHeader);
  }
  check(`${where}: no console errors or hydration warnings`, page.consoleErrors.length === 0, page.consoleErrors.slice(0, 3).join(" | "));
  await page.shot(shotName);
}

async function main(): Promise<void> {
  guardLocalOnly();
  const browser = findBrowser();
  if (!browser) {
    noteFailure("no Edge/Chrome found; set QA_BROWSER to a browser executable");
    return;
  }
  const password = process.env.DEMO_PASSWORD ?? "";
  if (password === "") {
    noteFailure("DEMO_PASSWORD is not set, so the login form cannot be used");
    return;
  }

  const profile = mkdtempSync(join(tmpdir(), "ms-qa-"));
  let child: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  let sid = "";
  try {
    child = await launch(browser, profile);
    const opened = await openPage();
    cdp = opened.cdp;
    const page = opened.page;
    const sql = getSql();

    // ---- 1. The real login form, on a phone ----------------------------------------------------------
    await page.setViewport(MOBILE);
    await page.goto("/");
    check("signed out, / sends you to the login page", (await page.pathname()) === "/login");
    const loginText = await page.text();
    check("  ...the login page shows the Demo login box and fits a phone", loginText.includes("Demo login") && (await page.eval<Audit>(AUDIT)).overflowPx <= 0);
    await page.shot("mobile-login");
    check("  ...the password field takes input (not echoed here)", await page.type("#password", password));
    check("  ...the Sign in button is clicked", await page.click("button", "Sign in"));
    check("  ...and you land in the app (Orders)", await page.waitFor(`location.pathname === '/orders'`));
    await page.settle();
    sid = await page.eval<string>("fetch('/api/auth/session').then((r) => r.json()).then((s) => s.sid || '')");
    check("  ...with a session of its own", sid.length > 10);

    // Diagnostic mode: QA_DIAG=/orders QA_DIAG_WIDTH=768 prints what sticks out on one page, then stops.
    if (process.env.QA_DIAG) {
      const width = Number(process.env.QA_DIAG_WIDTH ?? 768);
      await page.setViewport({ name: width < 768 ? "mobile" : width < 1280 ? "tablet" : "desktop", width, height: 900 });
      await page.goto(process.env.QA_DIAG);
      const out = await page.eval<unknown>(`(() => {
        const vw = document.documentElement.clientWidth;
        const all = Array.from(document.querySelectorAll('body *')).map((el) => ({ el, r: el.getBoundingClientRect() })).filter((x) => x.r.width > 0 && x.r.height > 0);
        const wide = all.sort((a, b) => b.r.right - a.r.right).slice(0, 6).map((x) => x.el.tagName.toLowerCase() + '.' + String(x.el.className || '').split(' ').slice(0, 4).join('.') + ' right=' + Math.round(x.r.right) + ' pos=' + getComputedStyle(x.el).position + ' scroller=' + (() => { let p = x.el.parentElement; while (p) { if (/(auto|scroll)/.test(getComputedStyle(p).overflowX)) return p.tagName.toLowerCase() + '.' + String(p.className || '').split(' ').slice(0, 3).join('.'); p = p.parentElement; } return 'none'; })());
        const scrollers = Array.from(document.querySelectorAll('*')).filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth + 1).map((e) => e.tagName.toLowerCase() + '.' + String(e.className || '').split(' ').slice(0, 3).join('.') + ' client=' + e.clientWidth + ' scroll=' + e.scrollWidth);
        return { vw, docScrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth, wide, scrollers };
      })()`);
      console.log(JSON.stringify(out, null, 1));
      return;
    }

    // ---- 2. Dashboard, Start demo, on a phone --------------------------------------------------------
    await page.goto("/");
    const dash = await page.text();
    check("Dashboard: both reset buttons and the Judge guide are there", dash.includes("Restart my demo") && dash.includes("Reset everything for all judges") && dash.includes("Judge guide"));
    await page.shot("mobile-dashboard-start");
    check("Start demo is clicked", await page.click("main button", "Start demo"));
    check("  ...a toast says the demo is ready", await page.waitFor(`document.querySelector('[aria-label="Notifications"]') && document.querySelector('[aria-label="Notifications"]').innerText.includes('Your demo is ready')`));
    check("  ...and you land on the Disputes inbox", await page.waitFor(`location.pathname === '/disputes'`));
    await page.settle();
    const inbox = await page.text();
    const inboxRows = await page.eval<number>(`document.querySelectorAll('tbody a[href^="/disputes/"]').length`);
    check("  ...which lists your three copies (3 rows, no 'Shared example' badge)", inboxRows === 3 && !inbox.includes("Shared example"), `${inboxRows} rows`);

    const copies = await page.eval<Record<string, string>>(
      "fetch('/api/demo/start', { method: 'POST' }).then((r) => r.json()).then((b) => Object.fromEntries(b.copies.map((c) => [c.seedDisputeId, c.disputeId])))",
    );
    const C = copies[seedId("dispute", "SEED-C")] ?? "";
    const E = copies[seedId("dispute", "SEED-E")] ?? "";
    check("  ...a second Start demo returns the same three copies", C.length === 36 && E.length === 36);

    // ---- 3. Every page at both widths, in the fresh-demo state (these are the screenshots) -----------------
    const pages: Array<[string, string, string, RegExp?]> = [
      ["Dashboard", "/", "dashboard", /Dashboard/],
      ["Orders", "/orders", "orders", /Orders/],
      ["Order detail (SEED-B)", `/orders/${seedId("order", "SEED-B")}`, "order-seed-b", /Order/],
      ["Disputes", "/disputes", "disputes", /Disputes/],
      ["Dispute hero (SEED-C copy)", `/disputes/${C}`, "dispute-hero", /Item not received/],
      ["Dispute (SEED-E copy)", `/disputes/${E}`, "dispute-seed-e", /Item not received|Not as described/],
      ["Insights", "/insights", "insights", /Insights/],
      ["Agent Activity", "/activity", "activity", /Agent Activity/],
    ];
    for (const v of [MOBILE, TABLET, DESKTOP]) {
      await page.setViewport(v);
      for (const [label, path, shot, h1] of pages) await auditPage(page, v, label, path, `${v.name}-${shot}`, h1);
    }

    // ---- 4. The dispute hero is usable on a phone: approve, simulate the outcome ------------------------
    await page.setViewport(MOBILE);
    await page.goto(`/disputes/${C}`);
    const hero = await page.text();
    check("Dispute hero on a phone: win likelihood 95% and Strong", /95\s?%/.test(hero) && hero.includes("Strong"), (/\d+\s?%/.exec(hero) ?? [""])[0]);
    check("  ...recommendation Contest, labelled 'System recommendation'", hero.includes("Contest") && hero.includes("System recommendation"));
    check("  ...the deadline countdown is shown (days and hours)", /\d+d \d+h/.test(hero), (/\d+d \d+h/.exec(hero) ?? ["none"])[0]);
    const draft = await page.eval<string>(`(document.querySelector('#draft') || {}).value || ''`);
    check("  ...the draft response is in the editable box", draft.includes("Hello PayPal"));
    check("  ...the label 'Explainable risk signals + AI reasoning' is next to the score", hero.includes("Explainable risk signals + AI reasoning"));
    const decisionInView = await page.eval<boolean>(`(() => { ${FIND} const b = find('main button', 'Approve'); if (!b) return false; const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= document.documentElement.clientWidth; })()`);
    check("  ...the Approve button fits inside the screen width", decisionInView);
    check("Approve is clicked", await page.click("main button", "Approve"));
    check("  ...a toast says 'Approved (simulated)'", await page.waitFor(`document.querySelector('[aria-label="Notifications"]').innerText.includes('Approved (simulated)')`));
    check("  ...the panel now says 'Action already executed' with a Simulated badge", await page.waitFor(`document.body.innerText.includes('Action already executed') && document.body.innerText.includes('Simulated')`));
    await page.shot("mobile-dispute-after-approve");
    check("  ...and offers Simulate outcome (Won / Lost)", (await page.text()).includes("Simulate outcome"));
    check("Won is clicked", await page.click("main button", "Won"));
    check("  ...a toast says the dispute was recorded as won", await page.waitFor(`document.querySelector('[aria-label="Notifications"]').innerText.includes('Recorded: dispute won')`));
    check("  ...the page header shows 'Won (simulated outcome)'", await page.waitFor(`document.body.innerText.includes('Won (simulated outcome)')`));
    check("  ...and the Simulate outcome control is gone", !(await page.text()).includes("Simulate outcome Simulated"));

    // ---- 5. Dashboard and Insights moved ------------------------------------------------------------------
    await page.goto("/");
    const after = await page.text();
    check("Dashboard now shows the simulated sub-label under Dollars protected", /\$145\.00 from simulated outcomes/.test(after));
    await page.shot("mobile-dashboard-after");
    await page.goto("/insights");
    const ins = await page.text();
    check("Insights shows the pending proposal with Approve change / Reject, and the outcome breakdown includes the new outcome", ins.includes("Proposed weight change") && ins.includes("Approve change") && /6 resolved in total/.test(ins));
    check("Approve change is clicked", await page.click("main button", "Approve change"));
    check("  ...a toast says the weight change was approved", await page.waitFor(`document.querySelector('[aria-label="Notifications"]').innerText.includes('Weight change approved')`));
    check("  ...the proposal card disappears and the first-time weight shows 23", await page.waitFor(`!document.body.innerText.includes('Proposed weight change') && /First-time buyer, high value\\s*(first_time_high_value\\s*)?23/.test(document.body.innerText)`));
    await page.shot("mobile-insights-after");

    // ---- 6. Mobile tab bar -------------------------------------------------------------------------------------
    await page.goto("/");
    const tabs = [["Orders", "/orders"], ["Disputes", "/disputes"], ["Insights", "/insights"], ["Agent Activity", "/activity"], ["Dashboard", "/"]] as const;
    for (const [label, href] of tabs) {
      const clicked = await page.click('nav[aria-label="Main"].fixed a', label);
      const arrived = await page.waitFor(`location.pathname === ${JSON.stringify(href)}`);
      await page.settle();
      const current = await page.eval<number>(`document.querySelectorAll('nav[aria-label="Main"].fixed [aria-current="page"]').length`);
      check(`bottom tab "${label}" goes to ${href} and is the only one marked current`, clicked && arrived && current === 1);
    }

    // ---- 7. Restart my demo and the Reset dialog, on a desktop --------------------------------------------------
    await page.setViewport(DESKTOP);
    await page.goto("/");
    check("Restart my demo is clicked (no dialog)", await page.click("main button", "Restart my demo"));
    check("  ...a toast says your demo was restarted", await page.waitFor(`document.querySelector('[aria-label="Notifications"]').innerText.includes('Your demo was restarted')`));
    check("  ...no confirmation dialog opened", await page.eval<boolean>("!document.querySelector('dialog[open]')"));
    await page.goto("/disputes");
    const afterRestart = await page.text();
    check("  ...your copies are gone: the Disputes inbox lists the three shared examples again", (afterRestart.match(/Shared example/g) ?? []).length >= 3);
    await page.goto("/");
    check("Start demo again recreates the copies", await page.click("main button", "Start demo") && (await page.waitFor(`location.pathname === '/disputes'`)));

    await page.goto("/");
    await waitForResetCooldown(sql);
    check("'Reset everything for all judges' opens the confirm dialog", (await page.click("main button", "Reset everything for all judges")) && (await page.waitFor("document.querySelector('dialog[open]')")));
    const dlg = await page.eval<{ text: string; inside: boolean }>(`(() => { const d = document.querySelector('dialog[open]'); const r = d.getBoundingClientRect(); return { text: d.innerText, inside: r.left >= 0 && r.right <= document.documentElement.clientWidth && r.top >= 0 && r.bottom <= window.innerHeight }; })()`);
    check("  ...it says 'This resets data for all judges' and fits the screen", dlg.text.includes("This resets data for all judges") && dlg.inside);
    await page.shot("desktop-reset-dialog");
    check("Cancel closes it without resetting", (await page.click("dialog button", "Cancel")) && (await page.waitFor("!document.querySelector('dialog[open]')")));
    check("Reset is confirmed", (await page.click("main button", "Reset everything for all judges")) && (await page.click("dialog button", "Reset for everyone")));
    check("  ...a toast says the demo was reset for everyone", await page.waitFor(`document.querySelector('[aria-label="Notifications"]').innerText.includes('Demo reset for everyone')`));
    check("  ...the dialog closed", await page.waitFor("!document.querySelector('dialog[open]')"));
    // The cooldown is 10 s from the reset, and a dev-server re-render can be slow, so repeat the click BEFORE anything else.
    check("Reset again straight away", (await page.click("main button", "Reset everything for all judges")) && (await page.click("dialog button", "Reset for everyone")));
    const cooling = await page.waitFor(`document.querySelector('[aria-label="Notifications"]').innerText.includes('Reset is cooling down') && /\\d+ s/.test(document.querySelector('[aria-label="Notifications"]').innerText)`, 8_000);
    check("  ...a toast says Reset is cooling down, with the seconds left", cooling, cooling ? "" : (await page.toasts()).replace(/\s+/g, " ").slice(0, 160));
    await page.shot("desktop-reset-cooldown");
    await page.settle();
    const reset = await page.text();
    check("  ...the Dashboard is back to the seed ($320.00 under review, no simulated sub-label)", reset.includes("$320.00") && !reset.includes("from simulated outcomes"));

    // ---- 8. A missing record -------------------------------------------------------------------------------------------
    page.consoleErrors.length = 0;
    const status = await page.eval<number>("fetch('/disputes/00000000-0000-4000-8000-000000000000').then((r) => r.status)");
    check("a dispute that does not exist is a real 404", status === 404);
    await page.goto("/disputes/00000000-0000-4000-8000-000000000000");
    const nf = await page.text();
    check("  ...with a friendly page and the navigation still there", nf.includes("We could not find that") && (await page.eval<Audit>(AUDIT)).sidebar);
    await page.setViewport(MOBILE);
    await page.goto("/disputes/00000000-0000-4000-8000-000000000000");
    check("  ...and on a phone it fits and keeps the tab bar", (await page.eval<Audit>(AUDIT)).overflowPx <= 0 && (await page.eval<Audit>(AUDIT)).bottomNav);
    info(`screenshots written to ${OUT}`);
  } catch (err) {
    noteFailure(`unexpected error: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
  } finally {
    cdp?.close();
    child?.kill();
    await sleep(500);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* Windows may still hold the profile for a moment */
    }
    if (sid) await cleanup([sid]).catch(() => noteFailure("cleanup failed"));
    await closeDb();
  }
}

void main().then(finish);
