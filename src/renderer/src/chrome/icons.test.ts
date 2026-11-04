import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChevronRight, FilePlus, FoldVertical, ICON_STROKE, UnfoldVertical } from "./icons";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const CATALOG = "chrome/icons.tsx";
const SPECIFIER = /["'](@hugeicons\/[^"']+)["']/g;
const DEEP_ICON = /^@hugeicons\/core-free-icons\/[A-Z][A-Za-z0-9]+Icon$/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

describe("hugeicons imports", () => {
  it("only deep-imports glyphs through chrome/icons.tsx", () => {
    const violations: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).replaceAll("\\", "/");
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(SPECIFIER)) {
        const spec = match[1];
        const allowedCatalog =
          rel === CATALOG &&
          (spec === "@hugeicons/react" || DEEP_ICON.test(spec));
        if (allowedCatalog) continue;
        violations.push(`${rel}: ${spec}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("draws fold/unfold as strokes, not filled chevrons", () => {
    for (const Icon of [FoldVertical, UnfoldVertical, FilePlus]) {
      const html = renderToStaticMarkup(createElement(Icon));
      expect(html, Icon.displayName).not.toMatch(/fill="currentColor"/);
      expect(html, Icon.displayName).toMatch(/stroke="currentColor"/);
    }
  });
});

describe("icon stroke", () => {
  it("defaults to the stroke docs/DESIGN.md names, and nothing restates it", () => {
    const design = readFileSync(join(SRC, "../../../docs/DESIGN.md"), "utf8");
    const section = design.slice(design.indexOf("## Iconography"));
    const named = /(\d+(?:\.\d+)?)px stroke/.exec(section)?.[1];
    expect(Number(named)).toBe(ICON_STROKE);
    expect(renderToStaticMarkup(createElement(ChevronRight))).toContain(`stroke-width="${ICON_STROKE}"`);

    // An explicit stroke equal to the default is noise that hides a real override.
    const restated: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (!file.endsWith(".tsx")) continue;
      const rel = relative(SRC, file).replaceAll("\\", "/");
      if (rel.startsWith("aliax/")) continue; // recharts' lines, not icons
      if (/strokeWidth=\{1\.5\}/.test(readFileSync(file, "utf8"))) restated.push(rel);
    }
    expect(restated).toEqual([]);
  });
});

describe("provider marks", () => {
  it("ships an asset for every mark HarnessIcon draws, Meta's among them", async () => {
    const { HARNESS_ICONS, MONOCHROME_HARNESSES } = await import("./HarnessIcon");
    const assets = readdirSync(join(SRC, "assets/providers")).map((f) => f.replace(/\.svg$/, "")).sort();
    expect(assets).toContain("meta");
    expect(Object.keys(HARNESS_ICONS).sort()).toEqual(assets);
    expect(MONOCHROME_HARNESSES.has("meta")).toBe(true);
  });

  it("draws Meta's mark in currentColor, like the other monochrome marks", async () => {
    const { HarnessIcon } = await import("./HarnessIcon");
    const html = renderToStaticMarkup(createElement(HarnessIcon, { harness: "meta" }));
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain('d="M6.915 4.03');
    expect(readFileSync(join(SRC, "assets/providers/meta.svg"), "utf8")).toContain('fill="currentColor" d="M6.915 4.03');
  });
});

describe("icon strokes", () => {
  it("are the icons' default: no strokeWidth prop on an icon outside chrome/icons and the charts", () => {
    // A thin glyph takes the next size up, never a heavier stroke (docs/DESIGN.md "Iconography").
    // Raw svg elements (<svg>, <circle>, <path>) draw their own marks; recharts' Line and Area are series.
    const KEEP = new Set(["Line", "Area"]);
    const found: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).replaceAll("\\", "/");
      if (!rel.endsWith(".tsx") || rel.endsWith(".test.tsx") || rel === CATALOG || rel.startsWith("aliax/charts/")) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/strokeWidth=/g)) {
        const tag = /<([A-Za-z][\w.]*)[^<]*$/.exec(source.slice(0, match.index))?.[1] ?? "";
        if (/^[A-Z]/.test(tag) && !KEEP.has(tag)) found.push(`${rel}: <${tag} strokeWidth>`);
      }
    }
    expect(found).toEqual([]);
  });
});

describe("disclosure chevrons", () => {
  it("turn on DISCLOSURE_CHEVRON's --dur-base, never the old --dur-fast", () => {
    const found: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).replaceAll("\\", "/");
      if (!rel.endsWith(".tsx")) continue;
      for (const match of readFileSync(file, "utf8").matchAll(/(["'`])([^"'`\n]*)\1/g)) {
        const text = match[2]!;
        if (/\brotate-90\b/.test(text) && text.includes("duration-(--dur-fast)")) found.push(`${rel}: ${text}`);
      }
    }
    expect(found).toEqual([]);
  });
});
