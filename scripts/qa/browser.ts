/**
 * Browser QA: drives a REAL headless Edge/Chrome (Chrome DevTools Protocol, no extra dependency)
 * through the signed-in app at a phone width (375 px) and a desktop width (1280 px).
 *
 *   npm run qa:browser            (the dev server must be running, DEMO_MODE=true)
 *   QA_SECTIONS=pages,feed npm run qa:browser   (only some sections; ids: start, pages, hero, tabs, reset, missing, feed,
 *                                                feedvisible, feedfaults, feedoutage). Each section has a hard limit (QA_SECTION_MS, default
 *                                                90 s); a section that hangs prints its last step, the requests still open and the
 *                                                last 20 page events, fails, and the run continues on a fresh tab.
 *   QA_TIMING=1                   prints how long every page load and settle took.
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
import { BASE, check as rawCheck, cleanup, count, closeDb, finish, getSql, guardLocalOnly, info, noteFailure, sleep, waitForResetCooldown } from "./common";

/** The last thing the script did or checked: a hang report names it. */
let lastStep = "(nothing yet)";
const check = (name: string, ok: boolean, extra = ""): boolean => {
  lastStep = `${ok ? "PASS" : "FAIL"}  ${name}`;
  return rawCheck(name, ok, extra);
};

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

  private closed = false;

  private constructor(private ws: WebSocket) {
    ws.addEventListener("close", () => this.failAll("the browser connection closed"));
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

  /** Every command has a deadline: a hung browser call fails with its name instead of stalling the whole run. */
  send<T = Params>(method: string, params: Params = {}, timeoutMs = 20_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`${method}: the browser connection is closed`));
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`CDP ${method} did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v as T)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private failAll(reason: string): void {
    this.closed = true;
    const pending = Array.from(this.waiting.values());
    this.waiting.clear();
    for (const w of pending) w.reject(new Error(reason));
  }

  onEvent(fn: (method: string, params: Params) => void): void {
    this.listeners.push(fn);
  }

  close(): void {
    this.failAll("the page connection was closed");
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

/**
 * Requests that look like ours but never reach the dev server (they are absent from its log): `/<GUID>/<GUID>/from?get&nocache=`
 * fires twice a second in this browser. They are kept out of the hang report so they do not bury the real events.
 */
const NOISE = /^\/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/; // upper-case GUID at the root; none of our routes look like that

/** One network request the page made, as the browser saw it. */
interface NetRequest {
  id: string;
  method: string;
  /** Path and query only (no origin), for readable logs. */
  url: string;
  startedAt: number;
  status?: number;
  durationMs?: number;
  /** Set when the request never completed (network error, aborted, CORS...). */
  failed?: string;
}

/** What to do with an intercepted request. */
type Decision = "continue" | { fail: string } | { status: number; body: string } | { delayMs: number };

class Page {
  consoleErrors: string[] = [];
  /** Every request since the last clearNet(), in order. */
  net: NetRequest[] = [];
  private byId = new Map<string, NetRequest>();

  /**
   * Requests that are the page still loading: started, not finished, younger than 4 s, and ours. Computed from the request
   * list each time rather than kept as a counter, because a counter drifts (a redirect, a request that never reports back, or
   * traffic injected from outside the page each left it above zero and made every settle() wait out its whole cap).
   */
  private busy(): number {
    const now = Date.now();
    return this.net.filter((r) => r.durationMs === undefined && !r.failed && !NOISE.test(r.url) && now - r.startedAt < 4000).length;
  }
  private viewport: Viewport = { name: "desktop", width: 1280, height: 800 };

  /** The last 20 things the page did (requests, responses, failures, console errors, navigations), for hang reports. */
  private recent: string[] = [];
  private loadWaiter: (() => void) | null = null;
  private log(line: string): void {
    this.recent.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
    if (this.recent.length > 20) this.recent.shift();
  }
  lastEvents(): string[] {
    return [...this.recent];
  }
  /** Requests started but not finished right now, oldest first. */
  openRequests(): string[] {
    return this.net.filter((r) => r.durationMs === undefined).map((r) => `${r.method} ${r.url} (${Date.now() - r.startedAt} ms so far)`);
  }

  constructor(private cdp: Cdp) {
    cdp.onEvent((method, params) => {
      this.lastEventAt = Date.now();
      if (method === "Page.loadEventFired") {
        this.loadedAt = Date.now();
        this.log("load event");
        this.loadWaiter?.();
      } else if (method === "Page.frameNavigated") {
        const frame = (params.frame ?? {}) as { url?: string; parentId?: string };
        if (!frame.parentId) this.log(`navigated to ${new URL(frame.url ?? "http://x/", BASE).pathname}`);
      }
      if (method === "Network.requestWillBeSent") {
        // A redirect re-announces the same request id: the first leg is finished, a new one starts.
        if (params.redirectResponse) {
          const before = this.byId.get(String(params.requestId));
          if (before) before.durationMs = Date.now() - before.startedAt;
        }
        const req = (params.request ?? {}) as { url?: string; method?: string };
        const url = new URL(req.url ?? "http://x/", BASE);
        const entry: NetRequest = { id: String(params.requestId), method: req.method ?? "GET", url: `${url.pathname}${url.search}`, startedAt: Date.now() };
        this.byId.set(entry.id, entry);
        this.net.push(entry);
        if (!NOISE.test(entry.url)) this.log(`-> ${entry.method} ${entry.url}`);
      } else if (method === "Network.responseReceived") {
        const entry = this.byId.get(String(params.requestId));
        if (entry) {
          entry.status = Number(((params.response ?? {}) as { status?: number }).status);
          if (!NOISE.test(entry.url)) this.log(`<- ${entry.status} ${entry.url}`);
        }
      } else if (method === "Network.loadingFinished") {
        const entry = this.byId.get(String(params.requestId));
        if (entry) entry.durationMs = Date.now() - entry.startedAt;
      } else if (method === "Network.loadingFailed") {
        const entry = this.byId.get(String(params.requestId));
        if (entry) {
          entry.durationMs = Date.now() - entry.startedAt;
          entry.failed = `${String(params.errorText ?? "failed")}${params.canceled ? " (cancelled)" : ""}`;
          this.log(`!! ${entry.url} ${entry.failed}`);
        }
      } else if (method === "Runtime.exceptionThrown") {
        const d = (params.exceptionDetails ?? {}) as { text?: string; exception?: { description?: string } };
        this.consoleErrors.push(`exception: ${(d.exception?.description ?? d.text ?? "").split("\n")[0]}`);
        this.log(this.consoleErrors[this.consoleErrors.length - 1]);
      } else if (method === "Runtime.consoleAPICalled" && params.type === "error") {
        const args = (params.args ?? []) as Array<{ value?: unknown; description?: string }>;
        this.consoleErrors.push(`console.error: ${args.map((a) => String(a.value ?? a.description ?? "")).join(" ").slice(0, 200)}`);
        this.log(this.consoleErrors[this.consoleErrors.length - 1]);
      } else if (method === "Log.entryAdded") {
        const e = (params.entry ?? {}) as { level?: string; text?: string; url?: string };
        if (e.level === "error") {
          this.consoleErrors.push(`log: ${e.text ?? ""} ${e.url ?? ""}`.slice(0, 200));
          this.log(this.consoleErrors[this.consoleErrors.length - 1]);
        }
      }
    });
  }

  async init(): Promise<void> {
    for (const domain of ["Page", "Runtime", "Network", "Log"]) await this.cdp.send(`${domain}.enable`);
    // Several tabs are open at once in the feed section: make each one behave as the focused, visible tab.
    await this.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
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
      if (this.busy() > 0) quietSince = Date.now();
      else if (Date.now() - quietSince > 700) break;
      await sleep(100);
    }
    // requestAnimationFrame can be paused for a tab the browser thinks is in the background: never wait on it alone.
    await this.eval<void>("new Promise((r) => { const t = setTimeout(r, 600); requestAnimationFrame(() => { clearTimeout(t); setTimeout(r, 250); }); })");
  }

  async goto(path: string): Promise<void> {
    lastStep = `doing: load ${path}`;
    const t0 = Date.now();
    const done = new Promise<void>((resolve) => (this.loadWaiter = resolve));
    await this.cdp.send("Page.navigate", { url: `${BASE}${path}` });
    const loaded = await Promise.race([done.then(() => true), sleep(45_000).then(() => false)]);
    this.loadWaiter = null;
    if (!loaded) this.log("no load event within 45 s");
    const t1 = Date.now();
    await this.settle();
    this.log(`goto ${path}: load ${t1 - t0} ms, settle ${Date.now() - t1} ms`);
    if (process.env.QA_TIMING) console.log(`   [timing] goto ${path}: load ${t1 - t0} ms, settle ${Date.now() - t1} ms`);
  }

  /** Milliseconds since the page last reported anything. */
  quietForMs(): number {
    return Date.now() - this.lastEventAt;
  }
  private lastEventAt = Date.now();

  async waitFor(expression: string, timeoutMs = 15_000): Promise<boolean> {
    lastStep = `doing: wait for ${expression.slice(0, 90)}`;
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
    lastStep = `doing: click ${selector} "${text ?? ""}"`;
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

  clearNet(): void {
    this.net = [];
    this.byId.clear();
  }

  // ---- fault injection: answer matching requests ourselves (or fail / delay them) ----------------------------
  private decide: ((url: string, n: number) => Decision) | null = null;
  private paused = 0;

  /** Intercept requests whose URL matches `pattern`; `decide` is called for each, with a running count. */
  async intercept(pattern: string, decide: (url: string, n: number) => Decision): Promise<void> {
    this.decide = decide;
    this.paused = 0;
    if (!this.interceptListening) {
      this.interceptListening = true;
      this.cdp.onEvent((method, params) => {
        if (method !== "Fetch.requestPaused" || !this.decide) return;
        const requestId = String(params.requestId);
        const url = String(((params.request ?? {}) as { url?: string }).url ?? "");
        const d: Decision = this.decide(url, ++this.paused);
        void (async () => {
          try {
            if (typeof d === "object" && "fail" in d) await this.cdp.send("Fetch.failRequest", { requestId, errorReason: d.fail });
            else if (typeof d === "object" && "status" in d) await this.cdp.send("Fetch.fulfillRequest", { requestId, responseCode: d.status, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(d.body).toString("base64") });
            else {
              if (typeof d === "object" && "delayMs" in d) await sleep(d.delayMs);
              await this.cdp.send("Fetch.continueRequest", { requestId });
            }
          } catch {
            /* the page navigated away while the request was held */
          }
        })();
      });
    }
    await this.cdp.send("Fetch.enable", { patterns: [{ urlPattern: pattern, requestStage: "Request" }] });
  }

  async stopIntercepting(): Promise<void> {
    this.decide = null;
    await this.cdp.send("Fetch.disable");
  }
  private interceptListening = false;

  /** Pretend the tab is hidden / visible (the page's own code reads document.visibilityState and listens for visibilitychange). */
  setTabVisible(visible: boolean): Promise<void> {
    return this.eval<void>(`(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => ${visible ? "'visible'" : "'hidden'"} }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => ${visible ? "false" : "true"} }); document.dispatchEvent(new Event('visibilitychange')); })()`);
  }

  /** The feed's status line (the small text next to its title) and its state attribute, if the new feed has one. */
  feedLine = (): Promise<{ text: string; state: string | null }> =>
    this.eval<{ text: string; state: string | null }>(`(() => { const p = Array.from(document.querySelectorAll('section p')).find((e) => /Updates every 5 seconds|Could not refresh|Refresh delayed|Live updates|session has ended|Retrying/.test(e.textContent || '')); return p ? { text: (p.textContent || '').trim(), state: p.getAttribute('data-feed-state') } : { text: '(no feed status line)', state: null }; })()`);

  /** Requests to the activity endpoint since the last clearNet(). */
  activityPolls = (): NetRequest[] => this.net.filter((r) => r.url.startsWith("/api/activity"));

  /** Activity requests that started within `ms` of the page's load event (or before it). */
  activityPollsNearLoad = (ms: number): NetRequest[] => this.activityPolls().filter((r) => r.startedAt - this.loadedAt < ms);
  private loadedAt = 0;

  /** Polls that went wrong: failed, answered with a non-2xx status, or still unanswered after 5 s. One still in flight is fine. */
  badPolls = (): NetRequest[] =>
    this.activityPolls().filter((r) => r.failed || (r.status !== undefined && (r.status < 200 || r.status >= 300)) || (r.status === undefined && Date.now() - r.startedAt > 5000));

  pathname = (): Promise<string> => this.eval<string>("location.pathname");
  text = (): Promise<string> => this.eval<string>("document.body.innerText");
  toasts = (): Promise<string> => this.eval<string>(`(document.querySelector('[aria-label="Notifications"]') || {}).innerText || ''`);

  async shot(name: string): Promise<void> {
    lastStep = `doing: screenshot ${name}`;
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
// Readers for the demo-script sections
// ---------------------------------------------------------------------------------------------------
/** The Dashboard's "Dollars protected" figure in dollars, or -1 if the card is not found. */
const protectedUsd = (page: Page): Promise<number> =>
  page.eval<number>(`(() => { const h = Array.from(document.querySelectorAll('h2')).find((e) => e.textContent.trim() === 'Dollars protected'); const t = h ? h.parentElement.parentElement.innerText : ''; const m = /\\$([\\d,]+(?:\\.\\d\\d)?)/.exec(t); return m ? Number(m[1].replace(/,/g, '')) : -1; })()`);

/** The Orders-list row for one order (found by its 8-character id) and the colour of its risk badge. */
const orderRow = (page: Page, orderId: string): Promise<{ text: string; amber: boolean; red: boolean } | null> =>
  page.eval(`(() => { const r = Array.from(document.querySelectorAll('tbody tr')).find((x) => x.textContent.includes(${JSON.stringify(orderId.slice(0, 8))})); if (!r) return null; return { text: r.innerText.replace(/\\s+/g, ' '), amber: Boolean(r.querySelector('[class*="border-amber-300"]')), red: Boolean(r.querySelector('[class*="border-red-300"]')) }; })()`);

/** What an order's detail page shows: the signals that fired, the explanation and the verification draft. */
const orderDetail = (page: Page): Promise<{ fired: string[]; explanation: string; draftSubject: string; draftBody: string; text: string }> =>
  page.eval(`(() => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    const fired = rows.filter((r) => r.cells[1] && r.cells[1].textContent.trim() === 'Yes').map((r) => r.cells[0].childNodes[0].textContent.trim());
    const ai = document.querySelector('section[aria-labelledby="ai"] p');
    const draft = Array.from(document.querySelectorAll('section[aria-labelledby="draft"] .rounded-md p'));
    return { fired, explanation: ai ? ai.textContent.trim() : '', draftSubject: draft[0] ? draft[0].textContent.trim() : '', draftBody: draft[1] ? draft[1].textContent.trim() : '', text: document.body.innerText.replace(/\\s+/g, ' ') };
  })()`);

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

interface Opened {
  cdp: Cdp;
  page: Page;
  targetId: string;
}

interface Section {
  id: string;
  title: string;
  run: (page: Page) => Promise<void>;
}

async function openPage(): Promise<Opened> {
  const url = `http://127.0.0.1:${PORT}/json/new?about:blank`;
  let res = await fetch(url, { method: "PUT" });
  if (!res.ok) res = await fetch(url);
  const target = (await res.json()) as { id: string; webSocketDebuggerUrl: string };
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  const page = new Page(cdp);
  await page.init();
  return { cdp, page, targetId: target.id };
}

/** Close a tab for real (dropping the connection alone leaves the tab, and its timers, running). */
async function closePage(o: Opened): Promise<void> {
  o.cdp.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${o.targetId}`).catch(() => undefined);
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
    let currentTab = opened;

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

    // Fault mode: QA_FAULT=401|slow|once500|network on QA_WATCH_PATH (default /) watches how the activity feed copes.
    if (process.env.QA_FAULT) {
      const kind = process.env.QA_FAULT;
      const seconds = Number(process.env.QA_WATCH_SECONDS ?? 25);
      const timeout = seconds * 1000 + 30_000; // give extra time for cleanup
      await page.setViewport(DESKTOP);
      await page.goto(process.env.QA_WATCH_PATH ?? "/");
      page.clearNet();
      const t0 = Date.now();
      await page.intercept("*/api/activity*", (_url, n) => {
        if (kind === "401") return { status: 401, body: '{"error":"unauthorized"}' };
        if (kind === "slow") return { delayMs: 12_000 };
        if (kind === "once500") return n === 1 ? { status: 500, body: '{"error":"boom"}' } : "continue";
        if (kind === "network") return n === 1 ? { fail: "ConnectionRefused" } : "continue";
        return "continue";
      });
      let last = "";
      const faultTimeout = setTimeout(() => { throw new Error(`fault mode timed out after ${timeout} ms`); }, timeout);
      while (Date.now() - t0 < seconds * 1000) {
        try {
          const line = await Promise.race([page.feedLine(), sleep(2000).then(() => ({ text: "(feedLine timed out)", state: null }))]);
          const key = `${line.state ?? "-"} | ${line.text}`;
          if (key !== last) {
            console.log(`  +${((Date.now() - t0) / 1000).toFixed(1)}s  status line: "${line.text}"${line.state ? `  [state=${line.state}]` : ""}`);
            last = key;
          }
        } catch (e) {
          console.log(`  +${((Date.now() - t0) / 1000).toFixed(1)}s  feedLine error: ${e instanceof Error ? e.message : String(e)}`);
        }
        await sleep(250);
      }
      clearTimeout(faultTimeout);
      await sleep(kind === "slow" ? 12_500 : 500); // let held requests finish so their timing is recorded
      const polls = page.activityPolls();
      let maxOverlap = 0;
      for (const a of polls) maxOverlap = Math.max(maxOverlap, polls.filter((b) => b.startedAt <= a.startedAt && a.startedAt < b.startedAt + (b.durationMs ?? 60_000)).length);
      console.log(`  ${polls.length} activity requests started in ${seconds}s; at most ${maxOverlap} in flight at once`);
      await page.stopIntercepting();
      return;
    }

    // Tab visibility test: QA_TAB_HIDE=/ QA_TAB_HIDE_SECONDS=n hides the tab for n seconds and reports poll activity.
    if (process.env.QA_TAB_HIDE) {
      const hideForSeconds = Number(process.env.QA_TAB_HIDE_SECONDS ?? 8);
      await page.setViewport(DESKTOP);
      await page.goto(process.env.QA_TAB_HIDE);
      page.clearNet();
      const t0 = Date.now();
      console.log(`  tab visible for 5s, then hidden for ${hideForSeconds}s, then visible for 7s`);
      await sleep(5_000);
      const beforeHide = page.activityPolls().length;
      console.log(`  +5s: ${beforeHide} polls so far; hiding tab now`);
      await page.setTabVisible(false);
      await sleep(hideForSeconds * 1000);
      const duringHide = page.activityPolls().length - beforeHide;
      console.log(`  +${5 + hideForSeconds}s: ${duringHide} polls while hidden; showing tab now`);
      await page.setTabVisible(true);
      await sleep(7_000);
      const afterShow = page.activityPolls().length - beforeHide - duringHide;
      console.log(`  +${5 + hideForSeconds + 7}s: ${afterShow} polls after tab became visible again`);
      const all = page.activityPolls();
      console.log(`  total: ${all.length} polls; while hidden: ${duringHide} (should be 0); after resume: ${afterShow} (should be at least 1, ideally 2+)`);
      return;
    }

    // Stress mode: QA_STRESS=1 hammers /api/activity from inside the signed-in page and reports every non-200 and the latency tail.
    if (process.env.QA_STRESS) {
      await page.setViewport(DESKTOP);
      await page.goto("/");
      const report = await page.eval<{ total: number; statuses: Record<string, number>; maxMs: number; p95Ms: number; errors: string[] }>(`(async () => {
        const statuses = {}; const times = []; const errors = [];
        const one = async () => {
          const t = performance.now();
          try { const r = await fetch('/api/activity?page=1&pageSize=5', { cache: 'no-store' }); const b = await r.json().catch(() => null); const k = r.ok && b && Array.isArray(b.entries) ? String(r.status) : r.status + ' (bad body)'; statuses[k] = (statuses[k] || 0) + 1; }
          catch (e) { statuses['network error'] = (statuses['network error'] || 0) + 1; errors.push(String(e)); }
          times.push(performance.now() - t);
        };
        for (let i = 0; i < 150; i++) { await one(); await new Promise((r) => setTimeout(r, 100)); }          // steady polling, 10 per second
        for (let burst = 0; burst < 6; burst++) { await Promise.all(Array.from({ length: 20 }, one)); await new Promise((r) => setTimeout(r, 300)); } // 20 at once
        times.sort((a, b) => a - b);
        return { total: times.length, statuses, maxMs: Math.round(times[times.length - 1]), p95Ms: Math.round(times[Math.floor(times.length * 0.95)]), errors: errors.slice(0, 3) };
      })()`);
      console.log(`stress: ${report.total} requests; statuses ${JSON.stringify(report.statuses)}; p95 ${report.p95Ms} ms; max ${report.maxMs} ms${report.errors.length ? `; errors ${report.errors.join(" | ")}` : ""}`);
      return;
    }

    // Watch mode: QA_WATCH=/ QA_WATCH_SECONDS=15 loads a page and prints every activity poll (status, timing) and the feed's text.
    if (process.env.QA_WATCH) {
      const seconds = Number(process.env.QA_WATCH_SECONDS ?? 15);
      await page.setViewport(DESKTOP);
      page.clearNet();
      await page.goto(process.env.QA_WATCH);
      const t0 = Date.now();
      let worst = "";
      let churned = false;
      while (Date.now() - t0 < seconds * 1000) {
        await sleep(500);
        // QA_WATCH_CHURN=1: after 3 s, ask the dev server for pages it has not compiled yet, all at once.
        if (process.env.QA_WATCH_CHURN && !churned && Date.now() - t0 > 3000) {
          churned = true;
          const routes = ["/insights", "/activity", "/disputes", "/orders", `/orders/${seedId("order", "SEED-B")}`, `/disputes/${seedId("dispute", "SEED-C")}`, `/disputes/${seedId("dispute", "SEED-D")}`];
          void page.eval<void>(`Promise.all(${JSON.stringify(routes)}.map((r) => fetch(r).then((x) => x.status).catch(() => 'failed')))`);
          console.log(`(+3s: asked for ${routes.length} uncompiled pages at once)`);
        }
        const msg = await page.eval<string>(`(() => { const p = Array.from(document.querySelectorAll('section p')).find((e) => /Updates every 5 seconds|Could not refresh/.test(e.textContent || '')); return p ? p.textContent.trim() : '(no feed status line)'; })()`);
        if (/Could not refresh/.test(msg)) worst = msg;
      }
      const last = await page.eval<string>(`(() => { const p = Array.from(document.querySelectorAll('section p')).find((e) => /Updates every 5 seconds|Could not refresh/.test(e.textContent || '')); return p ? p.textContent.trim() : '(no feed status line)'; })()`);
      console.log(`feed status line at the end: "${last}"${worst ? `   (it showed "${worst}" during the run)` : ""}`);
      console.log(`activity polls in ${seconds}s after load: ${page.activityPolls().length}`);
      for (const r of page.activityPolls()) console.log(`  +${((r.startedAt - t0) / 1000).toFixed(1)}s  ${r.method} ${r.url}  ->  ${r.failed ? `FAILED ${r.failed}` : r.status ?? "no response"}  ${r.durationMs ?? "?"} ms`);
      const bad = page.net.filter((r) => r.failed || (r.status !== undefined && r.status >= 400));
      console.log(`other failing requests: ${bad.filter((r) => !r.url.startsWith("/api/activity")).map((r) => `${r.url} -> ${r.failed ?? r.status}`).join(" | ") || "none"}`);
      console.log(`console errors: ${page.consoleErrors.length ? page.consoleErrors.slice(0, 5).join(" | ") : "none"}`);
      return;
    }

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

    // ---- The sections ----------------------------------------------------------------------------------------------
    // QA_SECTIONS=start,pages,hero,tabs,reset,missing,feed picks some; the default is all, in this order. Every section gets
    // its own page object, has a hard time limit (QA_SECTION_MS, default 90 s) and, if it hangs, is abandoned on a fresh tab.
    let C = "";
    let D = "";
    let E = "";
    let demoBaseline = 0; // Dollars protected right after a global Reset
    const loadCopies = async (pg: Page): Promise<void> => {
      if (!(await pg.eval<string>("location.origin")).startsWith("http")) await pg.goto("/orders");
      const copies = await pg.eval<Record<string, string>>(
        "fetch('/api/demo/start', { method: 'POST' }).then((r) => r.json()).then((b) => Object.fromEntries(b.copies.map((c) => [c.seedDisputeId, c.disputeId])))",
      );
      C = copies[seedId("dispute", "SEED-C")] ?? "";
      D = copies[seedId("dispute", "SEED-D")] ?? "";
      E = copies[seedId("dispute", "SEED-E")] ?? "";
    };

    const sections: Section[] = [
      { id: "start", title: "Dashboard and Start demo (phone)", run: async (page) => {
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

    await loadCopies(page);
    check("  ...a second Start demo returns the same three copies", C.length === 36 && E.length === 36);

    // Risk distribution card (desktop, two columns): a note when orders are on Hold, and no empty area under the caption.
    await page.setViewport(DESKTOP);
    await page.goto("/");
    const risk = await page.eval<{ hold: number; text: string; slack: number; stretch: number }>(`(async () => {
      const d = await fetch('/api/dashboard').then((r) => r.json());
      const card = document.querySelector('section[aria-labelledby="risk-heading"]');
      const r = card.getBoundingClientRect();
      const last = Array.from(card.children).filter((c) => c.getBoundingClientRect().height > 0).pop();
      const pad = parseFloat(getComputedStyle(card).paddingBottom);
      const sibling = card.parentElement.children[1];
      return { hold: d.verdict_distribution.hold, text: card.innerText, slack: Math.round(r.bottom - pad - last.getBoundingClientRect().bottom), stretch: Math.round(sibling.getBoundingClientRect().height - r.height) };
    })()`);
    const expectNote = risk.hold > 0 ? new RegExp(`${risk.hold} orders? on Hold needs? attention`).test(risk.text.replace(/\s+/g, " ")) : !/on Hold/.test(risk.text);
    check(`Risk distribution: the Hold note matches the data (${risk.hold} on Hold)`, expectNote, risk.text.replace(/\s+/g, " ").slice(-90));
    check(`  ...and nothing empty under the caption (${risk.slack}px of slack; the activity card beside it is ${risk.stretch}px taller)`, risk.slack <= 2);
      } },

      { id: "pages", title: "Every page at 375, 768 and 1280 px", run: async (page) => {
    await loadCopies(page);
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

      } },

      { id: "hero", title: "Dispute hero on a phone: approve, outcome, Dashboard and Insights move", run: async (page) => {
    await loadCopies(page);
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

      } },

      { id: "tabs", title: "Mobile tab bar", run: async (page) => {
    await page.setViewport(MOBILE);
    await page.goto("/");
    const tabs = [["Orders", "/orders"], ["Disputes", "/disputes"], ["Insights", "/insights"], ["Agent Activity", "/activity"], ["Dashboard", "/"]] as const;
    for (const [label, href] of tabs) {
      const clicked = await page.click('nav[aria-label="Main"].fixed a', label);
      const arrived = await page.waitFor(`location.pathname === ${JSON.stringify(href)}`);
      await page.settle();
      const current = await page.eval<number>(`document.querySelectorAll('nav[aria-label="Main"].fixed [aria-current="page"]').length`);
      check(`bottom tab "${label}" goes to ${href} and is the only one marked current`, clicked && arrived && current === 1);
    }

      } },

      { id: "reset", title: "Restart my demo and the global Reset dialog (desktop)", run: async (page) => {
    const sql = getSql();
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

      } },

      { id: "missing", title: "A missing record is a real 404", run: async (page) => {
    await page.setViewport(DESKTOP);
    await page.goto("/orders");
    page.consoleErrors.length = 0;
    const status = await page.eval<number>("fetch('/disputes/00000000-0000-4000-8000-000000000000').then((r) => r.status)");
    check("a dispute that does not exist is a real 404", status === 404);
    await page.goto("/disputes/00000000-0000-4000-8000-000000000000");
    const nf = await page.text();
    check("  ...with a friendly page and the navigation still there", nf.includes("We could not find that") && (await page.eval<Audit>(AUDIT)).sidebar);
    await page.setViewport(MOBILE);
    await page.goto("/disputes/00000000-0000-4000-8000-000000000000");
    check("  ...and on a phone it fits and keeps the tab bar", (await page.eval<Audit>(AUDIT)).overflowPx <= 0 && (await page.eval<Audit>(AUDIT)).bottomNav);

      } },

      { id: "feed", title: "Activity feed: 15 s of polling on four pages at 375, 768 and 1280 px", run: async (page) => {
    await loadCopies(page);
    // Four tabs side by side so 15 s of polling costs 15 s per width, not 60.
    const targets: Array<[string, string]> = [["/", "Dashboard"], ["/activity", "Agent Activity"], [`/orders/${seedId("order", "SEED-B")}`, "Order detail"], [`/disputes/${C}`, "Dispute detail"]];
    const tabs: Array<{ label: string; path: string; o: Opened }> = [];
    try {
      for (const [path, label] of targets) tabs.push({ label, path, o: await openPage() });
      for (const v of [MOBILE, TABLET, DESKTOP]) {
        for (const t of tabs) {
          await t.o.page.setViewport(v);
          await t.o.page.goto(t.path);
          t.o.page.clearNet();
        }
        await sleep(15_000);
        for (const t of tabs) {
          const polls = t.o.page.activityPolls();
          const bad = t.o.page.badPolls();
          const line = await t.o.page.feedLine();
          const visible = await t.o.page.eval<string>("document.visibilityState");
          const where = `${t.label} @ ${v.width}px`;
          check(`${where}: tab is visible, so the feed really was polling`, visible === "visible", visible);
          check(`${where}: after 15 s no "Could not refresh" (status line: "${line.text}")`, !/Could not refresh/.test(line.text) && line.state === "ok", `state=${line.state}`);
          check(`${where}: every activity poll was 2xx (${polls.length} polls)`, bad.length === 0 && polls.length > 0, bad.map((r) => `${r.url} -> ${r.failed ?? r.status}`).slice(0, 2).join(", "));
          check(`${where}: one poll per 5 s interval, not two (2 to 4 polls in ~15-20 s)`, polls.length >= 2 && polls.length <= 4, `${polls.length} polls at ${polls.map((p) => ((p.startedAt - polls[0].startedAt) / 1000).toFixed(1)).join("s, ")}s`);
        }
      }
    } finally {
      for (const t of tabs) await closePage(t.o);
    }
      } },

      { id: "feedvisible", title: "Activity feed: no request at mount, pauses when the tab is hidden, resumes when visible", run: async (page) => {
    await page.setViewport(DESKTOP);
    const waitPolls = async (n: number, ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end && page.activityPolls().length < n) await sleep(100);
      return page.activityPolls().length;
    };

    // Mount: the server already rendered the entries, so a page load makes no activity request of its own (not even the
    // second one React strict mode's double mount used to cause in development).
    page.clearNet();
    await page.goto("/");
    const mountPolls = page.activityPollsNearLoad(4_500);
    check("page load: no /api/activity request at mount (nothing within 4.5 s of the load event; the first poll is at 5 s)", mountPolls.length === 0, mountPolls.map((p) => p.url).join(" "));

    // Hidden tab: no polls; visible again: a poll straight away, then the normal cadence.
    const first = await waitPolls(1, 9_000);
    check("the feed polls on its own (first poll seen)", first >= 1, `${first} polls`);
    await page.setTabVisible(false);
    await sleep(100);
    const atHide = page.activityPolls().length;
    await sleep(11_000); // more than two intervals
    const duringHide = page.activityPolls().length - atHide;
    check("tab hidden for 11 s: no poll started while hidden", duringHide === 0, `${duringHide} polls`);
    await page.setTabVisible(true);
    const resumed = await waitPolls(atHide + 1, 2_000);
    check("  ...visible again: a poll starts within 2 s", resumed > atHide, `${resumed - atHide} polls`);
    const next = await waitPolls(atHide + 2, 8_000);
    check("  ...and the 5 s cadence continues", next >= atHide + 2, `${next - atHide} polls`);

      } },

      { id: "feedfaults", title: "Activity feed: quiet retry after one failed poll, filter change, session end", run: async (page) => {
    await page.setViewport(DESKTOP);
    const waitPolls = async (n: number, ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end && page.activityPolls().length < n) await sleep(100);
      return page.activityPolls().length;
    };

    // One failed poll: a quiet "Refresh delayed" state that clears on the next success.
    await page.goto("/");
    page.clearNet();
    await page.intercept("*/api/activity*", (_url, n) => (n === 1 ? { status: 500, body: '{"error":"boom"}' } : "continue"));
    const seen: string[] = [];
    const watch = async (state: string, ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const l = await page.feedLine();
        if (seen[seen.length - 1] !== l.state) seen.push(String(l.state));
        if (l.state === state) return l;
        await sleep(150);
      }
      return await page.feedLine();
    };
    const retry = await watch("retrying", 12_000);
    check("one failed poll (500): the feed shows the quiet 'Refresh delayed, retrying' state", retry.state === "retrying" && /Refresh delayed/.test(retry.text), `${retry.state}: ${retry.text}`);
    check("  ...and not an error message", !/Could not refresh/.test(retry.text));
    const back = await watch("ok", 12_000);
    check("  ...which clears on the next successful poll", back.state === "ok" && /Updates every 5 seconds/.test(back.text), `states seen: ${seen.join(" > ")}`);
    await page.stopIntercepting();

    // Changing a filter on /activity fetches the new query at once and never shows the old filter's rows under the new one.
    await page.goto("/activity");
    page.clearNet();
    await page.eval<void>("(() => { const s = document.querySelectorAll('select')[0]; s.value = 'llm_call'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
    const filtered = await waitPolls(1, 2_000);
    check("filter set to AI: the new query is requested within 2 s (not after the next 5 s tick)", filtered >= 1 && page.activityPolls()[0]?.url.includes("stepType=llm_call") === true, page.activityPolls().map((p) => p.url).join(" "));
    await sleep(800);
    const rowSteps = await page.eval<string[]>("Array.from(document.querySelectorAll('section ul li summary .sr-only')).map((e) => (e.textContent || '').trim())");
    check(`  ...and only AI rows are listed (${rowSteps.length} rows)`, rowSteps.every((s) => s === "AI step:"), Array.from(new Set(rowSteps)).join(", "));
    const filterLine = await page.feedLine();
    check("  ...and the status line is back to normal", filterLine.state === "ok", `${filterLine.state}`);

    // The session ends (401): say so once and stop polling, instead of retrying for ever.
    await page.stopIntercepting();
    await page.goto("/");
    page.clearNet();
    await page.intercept("*/api/activity*", () => ({ status: 401, body: '{"error":"unauthorized"}' }));
    const ended = await watch("session-ended", 12_000);
    check("a 401 poll: the feed says 'Your session has ended'", ended.state === "session-ended" && /session has ended/.test(ended.text), `${ended.state}: ${ended.text}`);
    const afterEnd = page.activityPolls().length;
    await sleep(11_000);
    check("  ...and stops polling (no more requests in 11 s)", page.activityPolls().length === afterEnd, `${page.activityPolls().length - afterEnd} more`);
    await page.stopIntercepting();
      } },

      { id: "feedoutage", title: "Activity feed: a short server outage (3 failed polls), then recovery without a reload", run: async (page) => {
    await page.setViewport(DESKTOP);
    await page.goto("/");
    page.clearNet();
    // The first three polls cannot reach the server (as when it is restarting); from the fourth on it is back.
    await page.intercept("*/api/activity*", (_url, n) => (n <= 3 ? { fail: "ConnectionRefused" } : "continue"));
    const t0 = Date.now();
    const seen: Array<[string, number]> = [];
    let last = "";
    while (Date.now() - t0 < 60_000) {
      const l = await page.feedLine();
      if (l.state !== last) {
        seen.push([String(l.state), Math.round((Date.now() - t0) / 1000)]);
        last = String(l.state);
      }
      if (seen.some(([s]) => s === "error") && l.state === "ok") break;
      await sleep(200);
    }
    const path = seen.map(([s, at]) => `${s}@${at}s`).join(" > ");
    check("outage: one failure shows the quiet retry, three in a row show the error text", seen.some(([s]) => s === "retrying") && seen.some(([s]) => s === "error"), path);
    check("  ...and once the server is back the feed recovers by itself, no reload (ok again)", seen[seen.length - 1]?.[0] === "ok", path);
    check("  ...with no overlapping requests and at most one try per interval while failing", page.activityPolls().length >= 4 && page.activityPolls().length <= 6, `${page.activityPolls().length} polls`);
    await page.stopIntercepting();
      } },

      // ---- M4-09: the demo script from tasks.md, driven through the real UI. demo1 -> demo2 -> demo3 are ONE story and must run
      // in this order (the default); demo1 starts with a global Reset, demo3 ends with one (step 14).
      { id: "demo1", title: "Demo script, steps 1-6, after a global Reset", run: async (page) => {
    const sql = getSql();
    await page.setViewport(DESKTOP);
    await page.goto("/");
    await waitForResetCooldown(sql);
    check("Reset (all judges) is opened and confirmed", (await page.click("main button", "Reset everything for all judges")) && (await page.click("dialog button", "Reset for everyone")));
    check("  ...the demo was reset for everyone", await page.waitFor(`document.querySelector('[aria-label="Notifications"]') && document.querySelector('[aria-label="Notifications"]').innerText.includes('Demo reset for everyone')`));
    await page.goto("/");
    demoBaseline = await protectedUsd(page);
    check("  ...the Dashboard is at the seed: Value under review $320.00, no simulated sub-label", (await page.text()).includes("$320.00") && !(await page.text()).includes("from simulated outcomes"), `Dollars protected $${demoBaseline}`);

    // 1. Log in: done once for the whole run through the real form (section 1 of this script).
    check("1. you are signed in (the session carries a session id)", sid.length > 10);

    // 2. Orders list
    await page.goto("/orders");
    const rowB = await orderRow(page, seedId("order", "SEED-B"));
    const rowF = await orderRow(page, seedId("order", "SEED-F"));
    check("2. SEED-B is amber, 'Verify first', 55", rowB !== null && rowB.amber && /Verify first\s*\u00b7?\s*55/.test(rowB.text), rowB?.text.slice(0, 80));
    check("  ...SEED-F is red, 'Hold', 70", rowF !== null && rowF.red && /Hold\s*\u00b7?\s*70/.test(rowF.text), rowF?.text.slice(0, 80));

    // 3. SEED-B
    await page.goto(`/orders/${seedId("order", "SEED-B")}`);
    const b = await orderDetail(page);
    check("3. SEED-B has exactly three active signals: country mismatch, first-time high value, rush shipping", b.fired.length === 3 && b.fired.includes("Billing and shipping countries differ") && b.fired.includes("First-time buyer, high value") && b.fired.includes("Rush or overnight shipping"), b.fired.join(" | "));
    check("  ...an AI explanation is shown", b.explanation.length > 40, `${b.explanation.length} chars`);
    check("  ...and a verification draft with a subject and a body", b.draftSubject.length > 3 && b.draftBody.length > 40, `${b.draftSubject.slice(0, 50)}`);

    // 4. SEED-F
    await page.goto(`/orders/${seedId("order", "SEED-F")}`);
    const f = await orderDetail(page);
    check("4. SEED-F has four active signals", f.fired.length === 4, f.fired.join(" | "));
    check("  ...and shows the threshold: $320.00 > 3 \u00d7 $85.00 usual order = $255.00", f.text.includes("$320.00 > 3 \u00d7 $85.00 usual order = $255.00"));

    // 5. Dispute inbox (Open): three shared examples, soonest deadline first; Start demo gives your own copies
    await page.goto("/disputes");
    const open = await page.eval<string[]>(`Array.from(document.querySelectorAll('tbody a[href^="/disputes/"]')).map((a) => a.getAttribute('href'))`);
    const wantOrder = [seedId("dispute", "SEED-E"), seedId("dispute", "SEED-D"), seedId("dispute", "SEED-C")].map((id) => `/disputes/${id}`);
    check("5. the Open tab lists SEED-E, SEED-D, SEED-C (deadlines in 40, 48 and 72 hours: soonest first)", JSON.stringify(open) === JSON.stringify(wantOrder), open.map((h) => h.slice(-4)).join(","));
    check("  ...each labelled 'Shared example'", count(await page.text(), "Shared example") === 3);
    await page.goto("/");
    check("  ...Start demo is clicked", await page.click("main button", "Start demo"));
    check("  ...and the Open tab then lists your own three copies (no 'Shared example')", (await page.waitFor(`location.pathname === '/disputes'`)) && (await page.waitFor(`document.querySelectorAll('tbody a[href^="/disputes/"]').length === 3 && !document.body.innerText.includes('Shared example')`)));

    // 6. Resolved tab: H1-H5 with outcome badges
    await page.goto("/disputes?tab=resolved");
    const resolved = await page.eval<{ rows: number; won: number; lost: number; refunded: number }>(`(() => { const t = Array.from(document.querySelectorAll('tbody tr')).map((r) => r.innerText); const n = (w) => t.filter((x) => new RegExp('\\\\b' + w + '\\\\b').test(x)).length; return { rows: t.length, won: n('Won'), lost: n('Lost'), refunded: n('Refunded') }; })()`);
    check("6. the Resolved tab lists H1-H5: 2 won, 1 lost, 2 refunded", resolved.rows === 5 && resolved.won === 2 && resolved.lost === 1 && resolved.refunded === 2, JSON.stringify(resolved));
      } },

      { id: "demo2", title: "Demo script, steps 7-11 (your own copies)", run: async (page) => {
    await loadCopies(page);
    const gotoText = async (path: string) => {
      await page.goto(path);
      return page.text();
    };

    // 7. SEED-C copy
    let t = await gotoText(`/disputes/${C}`);
    check("7. SEED-C: win likelihood 95%, Strong, Contest, 'System recommendation'", /95\s?%/.test(t) && t.includes("Strong") && t.includes("Contest") && t.includes("System recommendation"));
    check("  ...the evidence vault shows the Delivered scan", /Delivered/.test(t));

    // 8. Approve
    check("8. Approve is clicked", await page.click("main button", "Approve"));
    check("  ...a toast says 'Approved (simulated)' and the panel carries the Simulated badge", await page.waitFor(`document.querySelector('[aria-label="Notifications"]').innerText.includes('Approved (simulated)') && document.body.innerText.includes('Action already executed') && document.body.innerText.includes('Simulated')`));

    // 9. Simulate outcome Won
    check("9. Simulate outcome: Won is clicked", await page.click("main button", "Won"));
    check("  ...recorded as won", await page.waitFor(`document.body.innerText.includes('Won (simulated outcome)')`));
    await page.goto("/disputes?tab=resolved");
    check("  ...SEED-C's copy moved to the Resolved tab", await page.eval<boolean>(`Boolean(document.querySelector('tbody a[href="/disputes/${C}"]'))`));
    await page.goto("/disputes");
    check("  ...and left the Open tab", await page.eval<boolean>(`!document.querySelector('tbody a[href="/disputes/${C}"]')`));
    await page.goto("/");
    const afterWon = await protectedUsd(page);
    check(`  ...Dollars protected went up ($${demoBaseline} -> $${afterWon}) with a simulated sub-label`, afterWon > demoBaseline && (await page.text()).includes("from simulated outcomes"));

    // 10. SEED-D: refund; the outcome records itself
    t = await gotoText(`/disputes/${D}`);
    check("10. SEED-D: win likelihood 27%, Weak, recommendation Refund", /27\s?%/.test(t) && t.includes("Weak") && /Refund/.test(t));
    check("  ...Approve (accept claim) is clicked", await page.click("main button", "Approve"));
    check("  ...the outcome records itself as Refunded", await page.waitFor(`/Refunded/.test(document.body.innerText) && document.body.innerText.includes('Action already executed')`));
    check("  ...and there is no Simulate outcome control", !(await page.text()).includes("Simulate outcome"));
    await page.goto("/disputes?tab=resolved");
    check("  ...SEED-D's copy is in the Resolved tab as Refunded", await page.eval<boolean>(`(() => { const a = document.querySelector('tbody a[href="/disputes/${D}"]'); return Boolean(a) && /Refunded/.test(a.closest('tr').innerText); })()`));

    // 11. SEED-E
    t = await gotoText(`/disputes/${E}`);
    check("11. SEED-E: win likelihood 44%, Moderate, Contest", /44\s?%/.test(t) && t.includes("Moderate") && t.includes("Contest"));
    check("  ...evidence gaps are listed", t.includes("Evidence gaps") && (await page.eval<number>(`(() => { const h = Array.from(document.querySelectorAll('h2')).find((e) => e.textContent.trim() === 'Evidence gaps'); return h ? h.parentElement.querySelectorAll('li').length : 0; })()`)) > 0);
    check("  ...tracking says In Transit", /in.?transit/i.test(t));
    check("  ...and the countdown is red (under 48 hours)", await page.eval<boolean>(`Array.from(document.querySelectorAll('[class*="border-red-300"]')).some((e) => /left/.test(e.textContent))`));
      } },

      { id: "demo3", title: "Demo script, steps 12-14, double execution, Demo data badges", run: async (page) => {
    const sql = getSql();
    await page.setViewport(DESKTOP);
    await loadCopies(page);

    // 12. Insights
    await page.goto("/insights");
    let t = await page.text();
    check("12. Insights: a pending weight proposal, and the outcomes breakdown includes the history (7 resolved: 5 + your 2)", t.includes("Proposed weight change") && /7 resolved in total/.test(t), (/\d+ resolved in total/.exec(t) ?? ["?"])[0]);
    check("  ...Approve change is clicked", await page.click("main button", "Approve change"));
    check("  ...the weights update (first-time high value 20 -> 23)", await page.waitFor(`!document.body.innerText.includes('Proposed weight change') && /First-time buyer, high value\\s*(first_time_high_value\\s*)?23/.test(document.body.innerText)`));

    // 13. Dashboard
    await page.goto("/");
    t = await page.text();
    const protectedNow = await protectedUsd(page);
    check(`13. Dashboard: Dollars protected $${protectedNow} > 0 with a simulated sub-label; Value under review $320.00`, protectedNow > 0 && t.includes("from simulated outcomes") && t.includes("$320.00"));

    // Double execution is blocked
    await page.goto(`/disputes/${C}`);
    check("double execution: reopening an approved dispute says 'Action already executed' and offers no Approve button", (await page.text()).includes("Action already executed") && !(await page.eval<boolean>(`Array.from(document.querySelectorAll('main button')).some((b) => b.textContent.trim() === 'Approve')`)));
    const again = await page.eval<{ status: number; body: string }>(`fetch('/api/disputes/${C}/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'submit_evidence' }) }).then(async (r) => ({ status: r.status, body: JSON.stringify(await r.json()).slice(0, 120) }))`);
    const [counts] = await sql<{ approvals: number; executions: number }[]>`SELECT (SELECT count(*) FROM approval_records WHERE dispute_id = ${C})::int AS approvals, (SELECT count(*) FROM action_executions WHERE dispute_id = ${C})::int AS executions`;
    check("  ...a second Approve is answered 'already executed' and creates no second action execution row", /already_executed/.test(again.body) && counts?.approvals === 1 && counts?.executions === 1, `${again.status} ${again.body.slice(0, 60)}; approvals=${counts?.approvals} executions=${counts?.executions}`);

    // 14. Reset
    await page.goto("/");
    await waitForResetCooldown(sql);
    check("14. Reset (all judges) is opened and confirmed", (await page.click("main button", "Reset everything for all judges")) && (await page.click("dialog button", "Reset for everyone")));
    check("  ...the demo was reset for everyone", await page.waitFor(`document.querySelector('[aria-label="Notifications"]') && document.querySelector('[aria-label="Notifications"]').innerText.includes('Demo reset for everyone')`));
    await page.goto("/disputes");
    check("  ...SEED-C, D and E are back in the Open inbox as shared examples", count(await page.text(), "Shared example") === 3);
    await page.goto("/disputes?tab=resolved");
    check("  ...H1-H5 are in the Resolved tab", (await page.eval<number>(`document.querySelectorAll('tbody tr').length`)) === 5);
    await page.goto("/insights");
    t = await page.text();
    check("  ...the weight proposal is back and the weights are the defaults (first-time high value 20)", t.includes("Proposed weight change") && /First-time buyer, high value\s*(first_time_high_value\s*)?20/.test(t));
    await page.goto("/");
    t = await page.text();
    const protectedReset = await protectedUsd(page);
    check(`  ...Dollars protected is back to $${demoBaseline} (is $${protectedReset}), with no simulated sub-label`, protectedReset === demoBaseline && !t.includes("from simulated outcomes"));

    // "Demo data" badges on every seed-data component
    const badged: Array<[string, string, RegExp]> = [
      ["/", "Dashboard", /Demo data/],
      ["/orders", "Orders", /Demo data/],
      [`/orders/${seedId("order", "SEED-B")}`, "Order detail", /Demo data/],
      ["/disputes", "Disputes (Open)", /Shared example/],
      ["/disputes?tab=resolved", "Disputes (Resolved)", /Demo data/],
      [`/disputes/${seedId("dispute", "SEED-C")}`, "Dispute detail (shared example)", /Demo data|Shared example/],
      ["/insights", "Insights", /Demo data/],
      ["/activity", "Agent Activity", /Demo data/],
    ];
    for (const [path, label, pattern] of badged) {
      await page.goto(path);
      check(`'Demo data' badges: ${label} is labelled`, pattern.test(await page.text()));
    }
      } },
    ];

    // ---- run them -----------------------------------------------------------------------------------------------------
    const wanted = (process.env.QA_SECTIONS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = wanted.filter((w) => !sections.some((s) => s.id === w));
    if (unknown.length) noteFailure(`QA_SECTIONS names unknown section(s): ${unknown.join(", ")}. Known: ${sections.map((s) => s.id).join(", ")}`);
    let current = page;
    for (const section of sections) {
      if (wanted.length && !wanted.includes(section.id)) continue;
      const limit = Number(process.env.QA_SECTION_MS ?? 90_000);
      const t0 = Date.now();
      console.log(`\n== ${section.id}: ${section.title}`);
      lastStep = "(section starting)";
      const body = section.run(current).then(() => "done" as const, (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([body, new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), limit)))]);
      clearTimeout(timer);
      if (outcome !== "done") {
        const why = outcome === "timeout" ? `timed out after ${limit / 1000} s` : `stopped by an error: ${outcome.error.slice(0, 240)}`;
        noteFailure(`section "${section.id}" ${why}`);
        console.log(`   at ${new Date().toISOString().slice(11, 23)}; the page last reported anything ${(current.quietForMs() / 1000).toFixed(1)} s ago`);
        console.log(`   last step:   ${lastStep}`);
        console.log(`   open requests: ${current.openRequests().join(" | ") || "none"}`);
        console.log(`   console errors: ${current.consoleErrors.slice(-3).join(" | ") || "none"}`);
        console.log("   last 20 page events:");
        for (const line of current.lastEvents()) console.log(`     ${line}`);
        // Abandon the stuck tab: closing its connection fails everything it is waiting on, then carry on in a fresh tab.
        await closePage(currentTab);
        currentTab = await openPage();
        cdp = currentTab.cdp;
        current = currentTab.page;
      } else {
        // Leave no fault injection or hidden-tab override behind for the next section.
        await current.stopIntercepting().catch(() => undefined);
        await current.setTabVisible(true).catch(() => undefined);
        console.log(`   (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      }
    }
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
