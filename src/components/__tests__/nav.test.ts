import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NAV_ITEMS, isCurrentPath } from "@/lib/nav";

let pathname: string | null = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));

const root = join(__dirname, "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");
describe("navigation", async () => {
  const { BottomNav, SidebarNav, MobileHeader } = await import("@/components/app-nav");

  it("the dashboard matches only itself; other pages match their sub-pages too", () => {
    expect(isCurrentPath("/", "/")).toBe(true);
    expect(isCurrentPath("/orders", "/")).toBe(false);
    expect(isCurrentPath("/orders/abc", "/orders")).toBe(true);
    expect(isCurrentPath("/ordersX", "/orders")).toBe(false);
    expect(isCurrentPath("/disputes/6eb3", "/disputes")).toBe(true);
    expect(isCurrentPath(null, "/")).toBe(false);
  });

  it("has the five pages, in order", () => {
    expect(NAV_ITEMS.map((i) => i.href)).toEqual(["/", "/orders", "/disputes", "/insights", "/activity"]);
    expect(NAV_ITEMS.every((i) => i.shortLabel.length <= 9)).toBe(true); // five of them share 375 px
  });

  it("the bottom bar is mobile-only, has all five tabs, and marks only the current page", () => {
    pathname = "/disputes/abc";
    const html = renderToStaticMarkup(createElement(BottomNav));
    expect(html).toContain("md:hidden");
    expect(html).toContain("fixed inset-x-0 bottom-0");
    expect(html.match(/<a /g)).toHaveLength(5);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page"[^>]*aria-label="Disputes"|aria-label="Disputes"[^>]*aria-current="page"|href="\/disputes"[^>]*aria-current="page"/);
    expect(html).toContain('aria-label="Agent Activity"');
  });

  it("the sidebar lists the five pages and Sign out; the mobile header has the name and Sign out", () => {
    pathname = "/insights";
    const side = renderToStaticMarkup(createElement(SidebarNav));
    expect(side.match(/<a /g)).toHaveLength(5);
    expect(side).toContain("Sign out");
    expect(side.match(/aria-current="page"/g)).toHaveLength(1);
    const header = renderToStaticMarkup(createElement(MobileHeader));
    expect(header).toContain("md:hidden");
    expect(header).toContain("MoneySafe AI");
    expect(header).toContain("Sign out");
  });

  it("the layout shows the sidebar from md up only, and leaves room under the content for the bottom bar", () => {
    const layout = read("src/app/(app)/layout.tsx");
    expect(layout).toMatch(/<aside className="hidden[^"]*md:block/);
    expect(layout).toContain("pb-24 md:p-8 md:pb-8");
    expect(layout).toContain("<BottomNav />");
    expect(layout).toContain("<MobileHeader />");
  });
});

describe("sideways-scrolling tables", () => {
  it("a scroll container is positioned, so sr-only text inside a wide table cannot widen the page (found at 768 px)", () => {
    expect(read("src/app/globals.css")).toMatch(/\.overflow-x-auto\s*\{\s*position:\s*relative;/);
  });

  it("low-priority columns are hidden while the sidebar leaves a narrow content area (768-1023 px) and shown again after", async () => {
    const { COL_FROM_LG, COL_FROM_XL } = await import("@/components/table-columns");
    for (const classes of [COL_FROM_LG, COL_FROM_XL]) {
      expect(classes).toContain("hidden sm:table-cell md:hidden"); // shown on a phone, hidden at tablet width
    }
    expect(COL_FROM_LG).toContain("lg:table-cell");
    expect(COL_FROM_XL).toContain("xl:table-cell");
  });
});

describe("phone ergonomics", () => {
  it("phones get 44 px touch targets and 16 px form text", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*min-height: 2\.75rem/);
    expect(css).toMatch(/font-size: 16px/);
  });
});
