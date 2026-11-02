import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cubicBezier, DUR, EASE_DRAWER, EASE_EXIT, EASE_IN_OUT, EASE_OUT, REVEAL, SPRING_LAYOUT, SPRING_LAYOUT_CSS, springEasing } from "./ease";
import * as ease from "./ease";

const css = readFileSync(resolve(__dirname, "../index.css"), "utf8");
const components = readFileSync(resolve(__dirname, "../assets/components.css"), "utf8");

const token = (name: string) => css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();

describe("the motion tokens", () => {
  it("match the CSS durations", () => {
    expect(token("dur-fast")).toBe(`${DUR.fast * 1000}ms`);
    expect(token("dur-base")).toBe(`${DUR.base * 1000}ms`);
    expect(token("dur-slow")).toBe(`${DUR.slow * 1000}ms`);
    expect(token("dur-drawer")).toBe(`${DUR.drawer * 1000}ms`);
  });

  it("hold the reveal's fade to --dur-reveal", () => {
    expect(token("dur-reveal")).toBe(`${REVEAL.fadeMs}ms`);
    expect(token("ease-reveal")).toBe("linear");
  });

  it("drop the shimmer and the veil", () => {
    expect(token("motion-shimmer")).toBeUndefined();
    expect(Object.keys(ease)).not.toContain("VEIL");
  });

  it("match the CSS curves", () => {
    const bezier = (c: readonly number[]) => `cubic-bezier(${c.join(", ")})`;
    expect(token("ease-out")).toBe(bezier(EASE_OUT));
    expect(token("ease-drawer")).toBe(bezier(EASE_DRAWER));
    expect(token("ease-exit")).toBe(bezier(EASE_EXIT));
  });

  it("carry the layout spring as --dur-layout on --ease-layout", () => {
    const spring = springEasing(SPRING_LAYOUT);
    expect(token("dur-layout")).toBe(`${String(spring.ms)}ms`);
    expect(token("ease-layout")).toBe(spring.easing);
  });

  it("keeps one layout spring and no CSS copies of the curves", () => {
    expect(Object.keys(ease)).not.toContain("SPRING_SWAP");
    expect(Object.keys(ease)).not.toContain("EASE_DRAWER_CSS");
    expect(Object.keys(ease)).not.toContain("EASE_OUT_CSS");
  });
});

describe("springEasing", () => {
  const values = (easing: string) => easing.slice("linear(".length, -1).split(", ").map(Number);

  it("turns SPRING_LAYOUT into a curve that settles without overshoot", () => {
    expect(SPRING_LAYOUT_CSS).toEqual(springEasing(SPRING_LAYOUT));
    expect(SPRING_LAYOUT_CSS.ms).toBeGreaterThanOrEqual(250);
    expect(SPRING_LAYOUT_CSS.ms).toBeLessThanOrEqual(400);
    expect(SPRING_LAYOUT_CSS.ms % 10).toBe(0);
    const v = values(SPRING_LAYOUT_CSS.easing);
    expect(v).toHaveLength(32);
    expect(v[0]).toBe(0);
    expect(v.at(-1)).toBe(1);
    expect(Math.max(...v)).toBeLessThanOrEqual(1);
    for (let i = 1; i < v.length; i++) expect(v[i]).toBeGreaterThanOrEqual(v[i - 1]);
  });

  it("keeps an underdamped spring's overshoot", () => {
    expect(Math.max(...values(springEasing({ stiffness: 300, damping: 10, mass: 1 }).easing))).toBeGreaterThan(1);
  });
});

describe("cubicBezier", () => {
  it("starts at 0, ends at 1 and never runs backwards", () => {
    for (const points of [EASE_OUT, EASE_DRAWER, EASE_IN_OUT, EASE_EXIT]) {
      const curve = cubicBezier(points);
      expect(curve(0)).toBe(0);
      expect(curve(1)).toBe(1);
      expect(curve(-0.5)).toBe(0);
      expect(curve(2)).toBe(1);
      let last = 0;
      for (let i = 1; i < 100; i++) {
        const y = curve(i / 100);
        expect(y).toBeGreaterThanOrEqual(last - 1e-9);
        last = y;
      }
    }
  });

  it("is the identity for a straight line and front-loads an ease-out", () => {
    const line = cubicBezier([0.25, 0.25, 0.75, 0.75]);
    for (const t of [0.1, 0.37, 0.5, 0.9]) expect(line(t)).toBeCloseTo(t, 4);
    expect(cubicBezier(EASE_OUT)(0.25)).toBeGreaterThan(0.6);
    const inOut = cubicBezier(EASE_IN_OUT);
    expect(inOut(0.1)).toBeLessThan(0.1);
    expect(inOut(0.9)).toBeGreaterThan(0.9);
  });
});

describe("the folds that open on their own (components.css)", () => {
  /** The declarations of every rule whose selector list is exactly `selector`. */
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/,\s*/g, ",\\s*");
    return [...components.matchAll(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]);
  };

  it("runs .collapsible-auto on the layout spring with opacity over --dur-base, both ways", () => {
    const [main, reduced] = rule(".collapsible-auto,\n.collapsible-auto[data-ending-style]");
    expect(main).toContain("transition-property: height, opacity;");
    expect(main).toContain("transition-duration: var(--dur-layout), var(--dur-base);");
    expect(main).toContain("transition-timing-function: var(--ease-layout), var(--ease-out);");
    expect(reduced).toContain("transition-property: opacity;");
    expect(reduced).toContain("transition-duration: var(--dur-fast) !important;");
    // The reduced-motion block comes after every other .collapsible-auto rule.
    const reducedAt = components.indexOf("@media (prefers-reduced-motion: reduce) {\n  .collapsible-auto");
    expect(reducedAt).toBeGreaterThan(components.indexOf(".collapsible-auto[data-starting-style]"));
    expect(components.indexOf(".collapsible-auto", components.indexOf("\n}\n", reducedAt))).toBe(-1);
  });

  it("lands a step with a 4px rise over --dur-base and keeps it still under reduced motion", () => {
    const [land] = rule(".step-land");
    expect(land).toContain("transition-property: opacity, translate;");
    expect(land).toContain("transition-duration: var(--dur-base);");
    expect(land).toContain("transition-timing-function: var(--ease-out);");
    expect(components).toMatch(/@starting-style\s*\{\s*\.step-land\s*\{\s*opacity: 0;\s*translate: 0 4px;/);
    expect(components).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.step-land\s*\{\s*transition: none;/);
  });
});
