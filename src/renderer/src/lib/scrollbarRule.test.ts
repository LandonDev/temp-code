import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* One rule draws every native scroller on every platform (docs/DESIGN.md
 * "Scrolling"). These checks keep it that way: the rule is not scoped to a
 * platform, the thumb reads the tokens, the track never paints, nothing
 * overrides it with the standard properties, and no second scrollbar
 * component comes back. */
const ROOT = resolve(__dirname, "..");
const css = readFileSync(join(ROOT, "index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Innermost `selector { body }` blocks, the selector trimmed. */
function rules(text: string): { selector: string; body: string }[] {
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
}

const scrollbarRules = rules(css).filter((r) => r.selector.includes("::-webkit-scrollbar"));
const bodyOf = (selector: string): string => {
  const rule = scrollbarRules.find((r) => r.selector.split(",").map((s) => s.trim()).includes(selector));
  if (!rule) throw new Error(`no rule for ${selector}`);
  return rule.body;
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" || name === "node_modules" ? [] : sourceFiles(path);
    if (!/\.(tsx?|css)$/.test(name) || /\.test\.tsx?$/.test(name)) return [];
    return [path];
  });
}

describe("the scrollbar rule", () => {
  it("is not scoped to a platform", () => {
    expect(scrollbarRules.length).toBeGreaterThan(0);
    for (const r of scrollbarRules) expect(r.selector).not.toMatch(/is-mac/);
  });

  it("draws the thumb from the three tokens", () => {
    expect(bodyOf(":hover::-webkit-scrollbar-thumb")).toContain("var(--scrollbar-thumb)");
    expect(bodyOf("[data-scrolling]::-webkit-scrollbar-thumb")).toContain("var(--scrollbar-thumb)");
    expect(bodyOf("::-webkit-scrollbar-thumb:hover")).toContain("var(--scrollbar-thumb-hover)");
    expect(bodyOf("::-webkit-scrollbar-thumb:active")).toContain("var(--scrollbar-thumb-active)");
    expect(bodyOf("::-webkit-scrollbar-thumb")).toMatch(/background-color:\s*transparent/);
    expect(bodyOf("::-webkit-scrollbar")).toContain("var(--scrollbar-size)");
  });

  it("keeps the track and the corner transparent", () => {
    expect(bodyOf("::-webkit-scrollbar-track")).toMatch(/background:\s*transparent/);
    expect(bodyOf("::-webkit-scrollbar-corner")).toMatch(/background:\s*transparent/);
  });

  it("is never overridden by scrollbar-color or scrollbar-width outside .scrollbar-none", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(ROOT)) {
      const rel = relative(ROOT, path);
      const text = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      if (rel === "index.css") {
        for (const r of rules(text)) {
          if (/scrollbar-(color|width)\s*:/.test(r.body) && r.selector !== ".scrollbar-none") offenders.push(`${rel} ${r.selector}`);
        }
        continue;
      }
      if (/scrollbar-(color|width)\s*:|scrollbar(Color|Width)\s*:|\[scrollbar-(color|width):/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("has no second scrollbar component", () => {
    const importers = sourceFiles(ROOT)
      .filter((path) => /components\/ui\/scroll-area|["']\.\/scroll-area["']/.test(readFileSync(path, "utf8")))
      .map((path) => relative(ROOT, path));
    expect(importers).toEqual([]);
  });
});
