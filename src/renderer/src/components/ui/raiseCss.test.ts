import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The raised button's CSS in index.css (`.t-raise`): its press, its reduced-motion rule and its timing. */
const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const start = css.indexOf(".t-raise::before");
const end = css.indexOf(".t-raise-destructive::before");
const block = css.slice(start, css.indexOf("}", end) + 1);

/** The declarations of the first rule whose selector list holds this selector. */
function decl(selector: string, from = block): string {
  const at = from.indexOf(selector);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return from.slice(from.indexOf("{", at) + 1, from.indexOf("}", at));
}

describe("the raised button's CSS", () => {
  it("sits after the token layer, unlayered", () => {
    expect(start).toBeGreaterThan(css.indexOf("@theme inline"));
    expect(css.slice(0, start)).not.toMatch(/@layer[^{]*\{[^}]*$/);
  });

  it("presses the fill layer to 0.985 over --dur-fast, 0.997 by 0.985 full width", () => {
    const press = decl(".t-raise:active:not([aria-haspopup])::before");
    expect(press).toContain("scale: 0.985");
    expect(press).toContain("transition-duration: var(--dur-fast)");
    expect(decl(".t-raise.w-full:active:not([aria-haspopup])::before")).toContain("scale: 0.997 0.985");
  });

  it("releases over --dur-hover and lightens over --dur-fast", () => {
    const rest = decl(".t-raise::before");
    expect(rest).toContain("scale var(--dur-hover) var(--ease-out)");
    expect(rest).toContain("filter var(--dur-fast) var(--ease-out)");
    expect(rest).toContain("box-shadow: var(--raise-shadow)");
  });

  it("holds still under reduced motion", () => {
    const reduced = block.slice(block.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(decl(".t-raise:active::before", reduced)).toContain("scale: 1");
    expect(decl(".t-raise::before", reduced)).toContain("transition-duration: var(--dur-instant)");
  });

  it("writes no literal duration or colour", () => {
    expect(block).not.toMatch(/\d+m?s\b/);
    expect(block).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(|oklch\(/i);
  });

  it("names a shadow token for each variant in both themes", () => {
    for (const token of ["--raise-primary", "--raise-secondary", "--raise-destructive"]) {
      expect(css.match(new RegExp(`${token}:`, "g"))?.length, token).toBe(2);
    }
  });
});
