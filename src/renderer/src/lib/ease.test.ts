import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DUR, EASE_DRAWER, EASE_EXIT, EASE_OUT, SPRING_LAYOUT, SPRING_LAYOUT_CSS, springEasing } from "./ease";
import * as ease from "./ease";

const css = readFileSync(resolve(__dirname, "../index.css"), "utf8");

const token = (name: string) => css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();

describe("the motion tokens", () => {
  it("match the CSS durations", () => {
    expect(token("dur-fast")).toBe(`${DUR.fast * 1000}ms`);
    expect(token("dur-base")).toBe(`${DUR.base * 1000}ms`);
    expect(token("dur-slow")).toBe(`${DUR.slow * 1000}ms`);
    expect(token("dur-drawer")).toBe(`${DUR.drawer * 1000}ms`);
  });

  it("match the CSS curves", () => {
    const bezier = (c: readonly number[]) => `cubic-bezier(${c.join(", ")})`;
    expect(token("ease-out")).toBe(bezier(EASE_OUT));
    expect(token("ease-drawer")).toBe(bezier(EASE_DRAWER));
    expect(token("ease-exit")).toBe(bezier(EASE_EXIT));
  });

  it("keeps one layout spring and no CSS copies of the curves", () => {
    expect(Object.keys(ease)).not.toContain("SPRING_SWAP");
    expect(Object.keys(ease)).not.toContain("EASE_DRAWER_CSS");
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
