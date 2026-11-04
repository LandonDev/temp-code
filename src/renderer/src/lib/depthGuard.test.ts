import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Depth only where it belongs (docs/DESIGN.md "Shadow"): docked chrome casts
 * no shadow, every floating layer takes shadow-overlay, and the editors'
 * floating widgets are drawn like the app's own popovers.
 */

const ROOT = resolve(__dirname, "..");
const css = readFileSync(join(ROOT, "index.css"), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx$/.test(name) && !/\.(test|fixtures)\.tsx$/.test(name)) out.push(path);
  }
  return out;
}

/** The colour picker's thumbs float over the colours being picked: their shadow is the one allowed. */
const SHADOW_ALLOWED = new Set(["chrome/ColorPicker.tsx"]);

describe("depth", () => {
  it("draws no Tailwind step shadow on anything but the colour picker's thumbs", () => {
    const hits: string[] = [];
    for (const path of walk(ROOT)) {
      const file = relative(ROOT, path);
      if (SHADOW_ALLOWED.has(file)) continue;
      for (const m of readFileSync(path, "utf8").matchAll(/(?<![\w-])shadow-(?:xs|sm|md|lg|xl|2xl)(?![\w-])/g)) hits.push(`${file}: ${m[0]}`);
    }
    expect(hits).toEqual([]);
  });

  it("keeps no dead glass surface, floating surface or overlay colour", () => {
    expect(css).not.toMatch(/\.glass-surface|\.floating-surface|--color-overlay/);
  });

  it("draws Monaco's suggest, hover and usages widgets on the popover's fill, hairline and 12px radius", () => {
    for (const selector of [".monaco-editor .suggest-widget {", ".monaco-editor .monaco-hover {", ".monaco-editor .tc-usages {"]) {
      const start = css.indexOf(selector);
      expect(start, selector).toBeGreaterThan(0);
      const rule = css.slice(start, css.indexOf("}", start));
      expect(rule, selector).toMatch(/border-radius: var\(--radius-xl\)/);
      expect(rule, selector).toMatch(/background: var\(--popover\)/);
      expect(rule, selector).toMatch(/border: 1px solid var\(--border\)/);
    }
    // The light theme no longer repeats the dark rules.
    expect(css).not.toMatch(/\.theme-light \.monaco-editor \.(suggest-widget|monaco-hover) \{/);
  });

  it("draws CodeMirror's tooltip and autocomplete as a popover, its chosen row a muted fill", () => {
    const source = readFileSync(join(ROOT, "surfaces/editorChrome.ts"), "utf8");
    const tooltip = source.slice(source.indexOf('".cm-tooltip": {'), source.indexOf("},", source.indexOf('".cm-tooltip": {')));
    for (const token of ['backgroundColor: "var(--popover)"', 'border: "1px solid var(--border)"', 'borderRadius: "var(--radius-xl)"', 'boxShadow: "var(--shadow-overlay)"']) expect(tooltip).toContain(token);
    const chosen = source.slice(source.indexOf("li[aria-selected]"), source.indexOf("},", source.indexOf("li[aria-selected]")));
    expect(chosen).toContain('backgroundColor: "var(--muted)"');
  });
});
