import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Deterministic regression checks for the responsive / reflow / forced-colors
 * / reduced-motion contract (design §15.7, issue #18). jsdom cannot lay out
 * the page, so these are static source assertions that pin the CSS contract;
 * the actual 320 px, 400 % zoom, forced-colors, and reduced-motion behavior
 * is measured in a real browser and retained under
 * docs/testing/accessibility-evidence.md.
 */

const webRoot = resolve(import.meta.dirname, "../../apps/web/src");
const html = readFileSync(resolve(webRoot, "../index.html"), "utf8");
const styles = readFileSync(resolve(webRoot, "styles.css"), "utf8");

// Slices a fixed 2000-char window from the FIRST occurrence of the needle;
// pinned media blocks must stay shorter than the window and (for the
// max-width literals below) the sole occurrence in styles.css.
function blockAfter(needle: string): string {
  const start = styles.indexOf(needle);
  expect(start, `expected styles.css to contain ${needle}`).toBeGreaterThan(-1);
  return styles.slice(start, start + 2000);
}

describe("responsive and adaptive CSS contract (design §15.7)", () => {
  it("index.html keeps the language, title, and a zoom-capable viewport", () => {
    expect(html).toMatch(/lang="en"/);
    expect(html).toMatch(/<title>Flight Route Explorer<\/title>/);
    expect(html).toMatch(/name="viewport"\s+content="width=device-width, initial-scale=1"/);
    expect(html).not.toMatch(/user-scalable=no/i);
    expect(html).not.toMatch(/maximum-scale/i);
  });

  it("declares the 320 px minimum viewport contract", () => {
    expect(styles).toMatch(/body\s*\{[^}]*min-width:\s*320px/);
  });

  it("ships the DISPATCH breakpoints", () => {
    // blockAfter resolves the first occurrence, so the pinned literals must
    // remain unique; earlier Task-6/7 mobile blocks use `width <= 760px`
    // range syntax to keep it that way.
    expect(styles.split("@media (max-width: 1279px)").length - 1).toBe(1);
    expect(styles.split("@media (max-width: 760px)").length - 1).toBe(1);
    const mid = blockAfter("@media (max-width: 1279px)");
    expect(mid).toMatch(/\.workbench\s*\{[^}]*max-height:\s*55vh/);
    expect(mid).toMatch(/\.manifest\s*\{\s*display:\s*none/);
    const mobile = blockAfter("@media (max-width: 760px)");
    // The h1 must stay in the accessibility tree at mobile: sr-only clip
    // technique, never display:none.
    expect(mobile).not.toMatch(/\.product-mark\s*\{\s*display:\s*none/);
    expect(mobile).toMatch(/\.map-cell \.map-stage\s*\{\s*height:\s*55vh/);
    expect(mobile).toMatch(/\.product-mark\s*\{\s*clip:\s*rect\(0\s+0\s+0\s+0\);\s*clip-path:\s*inset\(50%\);[^}]*height:\s*1px;[^}]*overflow:\s*hidden;[^}]*position:\s*absolute;[^}]*width:\s*1px/);
    expect(mobile).toMatch(/\.doc-control-footer span:not\(\.footer-asof\)/);
  });

  it("keeps the route table inside a named, independently scrollable region", () => {
    const table = blockAfter(".table-scroll");
    expect(table).toMatch(/\.table-scroll\s*\{\s*overflow-x:\s*auto/);
    expect(table).toMatch(/table\s*\{[^}]*min-width:\s*540px/);
    // The shell must not add its own minimum width: page-level reflow
    // (no two-dimensional scroll) is measured in the real browser, but this
    // pins that only the table's own scroll container has a fixed minimum.
    expect(styles).toMatch(/\.map-first-shell\s*\{\s*max-width:\s*none;/);
    expect(styles.match(/\.map-first-shell[^}]*min-width/)).toBeNull();
  });

  it("ships a reduced-motion fallback for every animation and transition", () => {
    expect(styles).toMatch(/transition:\s*[^;}]+/);
    expect(styles).toMatch(/animation:\s*[^;}]+/);
    const reduced = blockAfter("@media (prefers-reduced-motion: reduce)");
    expect(reduced).toMatch(/animation-duration:\s*\.01ms/);
    expect(reduced).toMatch(/transition-duration:\s*\.01ms/);
  });

  it("ships forced-colors rules that keep every layer distinguishable", () => {
    const forced = blockAfter("@media (forced-colors: active)");
    for (const selector of [
      ".route-path",
      ".route-shadow",
      ".world-graticule",
      ".map-marker circle:first-child",
      ".map-marker text",
      ".gap-boundary circle",
      ".legend-line",
      ".legend-dot",
      ".legend-gap",
      ".map-fallback-banner",
      ".map-hud",
      ".map-endpoint",
      ".map-attribution",
      ".safety-banner",
      ".map-legend",
      ".restore-controls",
      ".map-rail button",
      ".workbench-spine button",
      ".compass-rose",
      ".map-scalebar",
    ]) {
      expect(forced, `forced-colors block must style ${selector}`).toMatch(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    expect(forced).toMatch(/outline-color:\s*Highlight/);
  });

  it("does not disable focus outlines anywhere (visible focus)", () => {
    const outlineNoneRules = styles.match(/([^{}]+)\{[^}]*outline:\s*none[^}]*\}/g) ?? [];
    for (const rule of outlineNoneRules) {
      const selector = rule.slice(0, rule.indexOf("{")).trim().split(",").map((part) => part.trim());
      for (const single of selector) {
        const escaped = single.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
        expect(styles, `selector ${single} must have a :focus/:focus-visible replacement`).toMatch(new RegExp(escaped + "\\s*:\\s*focus(-visible)?\\s*\\{"));
      }
    }
  });
});
