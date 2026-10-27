import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DUR, EASE_DRAWER, EASE_EXIT, EASE_OUT, SPRING_LAYOUT, SPRING_SWAP } from "./ease";

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

  it("keeps one layout spring", () => {
    expect(SPRING_SWAP).toBe(SPRING_LAYOUT);
  });
});
