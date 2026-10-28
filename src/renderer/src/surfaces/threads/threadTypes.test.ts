import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TypeGlyph } from "./TypeGlyph";
import { THREAD_MENU_ICONS, THREAD_TYPES, typeTint } from "./threadTypes";

describe("typeTint", () => {
  it("maps every thread type to its own tint class", () => {
    for (const type of THREAD_TYPES) expect(typeTint(type)).toBe(`text-type-${type}`);
  });

  it("spells every tint class out whole in its source, so Tailwind's scanner generates it", () => {
    const source = readFileSync(join(__dirname, "threadTypes.ts"), "utf8");
    for (const type of THREAD_TYPES) expect(source, type).toContain(`"text-type-${type}"`);
  });

  it("draws an absent or unknown type as chat", () => {
    expect(typeTint(undefined)).toBe("text-type-chat");
    expect(typeTint("toString" as never)).toBe("text-type-chat");
  });
});

describe("THREAD_MENU_ICONS", () => {
  it("renders each type's glyph with its tint at the menu's stroke", () => {
    for (const type of THREAD_TYPES) {
      const html = renderToStaticMarkup(createElement(THREAD_MENU_ICONS[type], { strokeWidth: 1.5 }));
      expect(html, type).toContain(`data-type-glyph="${type}"`);
      expect(html, type).toContain(`class="text-type-${type}"`);
      expect(html, type).toContain('stroke-width="1.5"');
    }
  });

  it("keeps each icon's identity, so a menu row does not remount it", () => {
    expect(THREAD_MENU_ICONS.chat).toBe(THREAD_MENU_ICONS.chat);
    expect(new Set(Object.values(THREAD_MENU_ICONS)).size).toBe(THREAD_TYPES.length);
  });
});

describe("TypeGlyph", () => {
  it("draws the type's glyph tinted, hidden from assistive tech, at the caller's size", () => {
    const html = renderToStaticMarkup(createElement(TypeGlyph, { type: "research", className: "size-3.5" }));
    expect(html).toContain('data-type-glyph="research"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toMatch(/class="shrink-0 text-type-research size-3\.5"/);
  });

  it("draws chat for a thread with no type", () => {
    expect(renderToStaticMarkup(createElement(TypeGlyph, { type: undefined }))).toContain('data-type-glyph="chat"');
  });
});

/* A type glyph is drawn tinted everywhere: through `TypeGlyph`, or as a menu
 * row's icon through `THREAD_MENU_ICONS`. Reading THREAD_GLYPHS anywhere else
 * draws one uncoloured again; a type tint on anything but a glyph (a title,
 * a fill) breaks the 3:1-only contrast rule. Exceptions name their file and
 * their reason, as colourGuard's do. */
const RENDERER = resolve(__dirname, "../..");
const OWNERS = new Set(["surfaces/threads/threadTypes.ts", "surfaces/threads/TypeGlyph.tsx"]);
const EXCEPTIONS: Record<string, string> = {};

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(name) && !/\.(test|fixtures)\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("the type glyph guard", () => {
  const offenders = (pattern: RegExp) =>
    sources(RENDERER)
      .map((path) => relative(RENDERER, path))
      .filter((file) => !OWNERS.has(file) && !EXCEPTIONS[file])
      .filter((file) => pattern.test(readFileSync(join(RENDERER, file), "utf8")));

  it("draws no type glyph outside TypeGlyph and THREAD_MENU_ICONS", () => {
    expect(offenders(/\bTHREAD_GLYPHS\b/)).toEqual([]);
  });

  it("puts a type tint on nothing but a glyph", () => {
    expect(offenders(/\btypeTint\(|\btext-type-/)).toEqual([]);
  });
});
