import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { describeError, loadingLabel } from "@/lib/ui-errors";
import { SCORING_LABEL } from "@/lib/format";

const root = join(__dirname, "..", "..", "..");
const src = join(root, "src");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");
const walk = (dir: string, accept: (file: string) => boolean): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : walk(full, accept);
    return accept(full) ? [full] : [];
  });
const rel = (file: string) => relative(root, file).replace(/\\/g, "/");

describe("describeError", () => {
  it("never repeats the error's own message, and reassures truthfully", () => {
    const view = describeError({ digest: "abc123" } as { digest: string }, "the Insights page");
    expect(view.title).toBe("Something went wrong");
    expect(view.message).toContain("We could not show the Insights page.");
    expect(view.message).toContain("Nothing was changed and nothing was sent to PayPal");
    expect(view.reference).toBe("abc123");
  });

  it("shows a reference only when Next gave a digest, and caps its length", () => {
    expect(describeError({}).reference).toBeNull();
    expect(describeError({ digest: "x".repeat(80) }).reference).toHaveLength(24);
  });

  it("loadingLabel reads as a sentence", () => {
    expect(loadingLabel("orders")).toBe("Loading orders…");
  });
});

describe("shared states (rendered to HTML)", async () => {
  const { ErrorCard } = await import("@/components/ui/error-card");
  const { EmptyState, SectionSkeleton } = await import("@/components/ui/states");
  const { ScoringLabel } = await import("@/components/scoring-label");

  it("ErrorCard is an alert with a Try again button only when it can retry, and shows the reference", () => {
    const withRetry = renderToStaticMarkup(createElement(ErrorCard, { what: "the dispute", error: { digest: "ref-9" }, onRetry: () => undefined }));
    expect(withRetry).toContain('role="alert"');
    expect(withRetry).toContain("We could not show the dispute.");
    expect(withRetry).toContain("Try again");
    expect(withRetry).toContain("Reference: ref-9");
    expect(renderToStaticMarkup(createElement(ErrorCard, {}))).not.toContain("<button");
  });

  it("ErrorCard disables the button and says so while retrying", () => {
    const html = renderToStaticMarkup(createElement(ErrorCard, { onRetry: () => undefined, retrying: true }));
    expect(html).toContain("Trying again…");
    expect(html).toContain("disabled");
  });

  it("EmptyState says what is missing and offers the next step", () => {
    const html = renderToStaticMarkup(createElement(EmptyState, { title: "No orders yet", action: createElement("button", null, "Create one") }, "Create a sandbox order above."));
    expect(html).toContain("No orders yet");
    expect(html).toContain("Create a sandbox order above.");
    expect(html).toContain("Create one");
  });

  it("SectionSkeleton announces itself as busy, with a label, and draws the requested rows", () => {
    const html = renderToStaticMarkup(createElement(SectionSkeleton, { what: "agent activity", rows: 4 }));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading agent activity…"');
    expect(html.match(/animate-pulse/g)).toHaveLength(5); // the title bar + 4 rows
  });

  it("ScoringLabel carries the exact REQ-NFR-01 wording", () => {
    expect(SCORING_LABEL).toBe("Explainable risk signals + AI reasoning");
    expect(renderToStaticMarkup(createElement(ScoringLabel))).toContain(SCORING_LABEL);
  });
});

describe("REQ-NFR-01: the scoring label, and no 'trained fraud model'", () => {
  /** Strip comments, so a comment that says what NOT to write is not mistaken for UI text. */
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const FORBIDDEN = /trained\s+(fraud\s+)?model|ai\s+fraud\s+detection|fraud[- ]detection\s+(model|engine|ai)|machine[- ]learning\s+(fraud|risk)\s+model/i;

  it("no file under src (components, pages, seed text, prompts) uses a forbidden description", () => {
    const files = walk(src, (f) => /\.(ts|tsx)$/.test(f));
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.filter((f) => FORBIDDEN.test(code(readFileSync(f, "utf8")))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("the guard itself recognises the phrases it forbids", () => {
    for (const bad of ["a trained fraud model", "Trained model", "AI fraud detection", "our fraud detection engine"]) expect(FORBIDDEN.test(bad), bad).toBe(true);
    expect(FORBIDDEN.test("explainable risk signals + AI reasoning")).toBe(false);
  });

  it.each([
    ["src/app/(app)/orders/(list)/page.tsx"],
    ["src/app/(app)/orders/[id]/page.tsx"],
    ["src/app/(app)/disputes/[id]/page.tsx"],
    ["src/components/dashboard/risk-donut.tsx"],
    ["src/components/insights/weights-table.tsx"],
  ])("%s shows the label where it shows scores", (file) => {
    const text = read(...file.split("/"));
    expect(text).toContain("<ScoringLabel");
  });
});

describe("feedback rules", () => {
  it("every client component that POSTs reports the result with a toast", () => {
    const posting = walk(join(src, "components"), (f) => f.endsWith(".tsx")).filter((f) => /method:\s*"POST"/.test(readFileSync(f, "utf8")));
    expect(posting.length).toBeGreaterThanOrEqual(10);
    const silent = posting.filter((f) => !/useToast\(\)/.test(readFileSync(f, "utf8"))).map(rel);
    expect(silent).toEqual([]);
  });

  it("list pages and the dashboard have a loading skeleton; detail pages do not (it would turn a 404 into a 200)", () => {
    const pages = ["(dashboard)", "orders/(list)", "disputes/(list)", "insights", "activity"];
    for (const p of pages) expect(existsSync(join(src, "app", "(app)", p, "loading.tsx")), p).toBe(true);
    for (const p of ["orders/[id]", "disputes/[id]"]) expect(existsSync(join(src, "app", "(app)", p, "loading.tsx")), p).toBe(false);
  });

  it("the signed-in app has a route error boundary with retry, a 404 page, and a global fallback", () => {
    expect(read("src/app/(app)/error.tsx")).toContain("router.refresh()");
    expect(read("src/app/(app)/error.tsx")).toContain("reset()");
    expect(existsSync(join(src, "app", "(app)", "not-found.tsx"))).toBe(true);
    expect(read("src/app/global-error.tsx")).toContain("Try again");
  });

  it("the detail pages stream their activity feed behind a skeleton, and wrap the decision panel in a section boundary", () => {
    for (const page of ["src/app/(app)/orders/[id]/page.tsx", "src/app/(app)/disputes/[id]/page.tsx"]) {
      const text = read(...page.split("/"));
      expect(text).toContain("<Suspense fallback={<ActivitySkeleton />}>");
    }
    expect(read("src/app/(app)/disputes/[id]/page.tsx")).toContain('<SectionBoundary what="decision panel">');
  });
});
