import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* One focus ring: index.css draws an inset outline on every control and on
   `focus-ring`. A `focus-visible:ring` would draw a second, outer band that
   an overflow-hidden parent clips. Fields keep `focus-field`, an invalid
   field its `aria-invalid:ring`: neither is a focus ring. The allow-list
   only shrinks; it is empty. */
const ALLOWED: Record<string, number> = {};

const root = resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("the focus ring", () => {
  it("is index.css's one outline: no focus-visible or focus-within ring anywhere in the renderer", () => {
    const found: Record<string, number> = {};
    for (const path of walk(root)) {
      const hits = readFileSync(path, "utf8").match(/focus-(?:visible|within):(?:[\w-]+:)*ring\b[^\s"'`]*/g);
      if (hits) found[relative(root, path)] = hits.length;
    }
    expect(found).toEqual(ALLOWED);
  });

  it("names focus-ring in the global rule", () => {
    const css = readFileSync(join(root, "index.css"), "utf8");
    const rule = css.slice(css.indexOf(".focus-ring:focus-visible"), css.indexOf("}", css.indexOf(".focus-ring:focus-visible")));
    expect(rule).toContain("button:focus-visible");
    expect(rule).toContain("outline: 2px solid var(--color-accent)");
    expect(rule).toContain("outline-offset: -2px");
  });
});
