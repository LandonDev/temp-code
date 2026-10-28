import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrast, luminance, resolve, themes } from "./colourMath";

/**
 * The status colours are text as often as they are fills (counts, "Failed",
 * "Needs you", a hunk's +n −n), so each reaches 4.5:1 as small text on every
 * surface it sits on, in both themes. The selected row's fill is `muted`.
 */
const { dark, light } = themes(readFileSync(join(__dirname, "../index.css"), "utf8"));

const STATUS = ["--thread-success", "--thread-warning", "--thread-danger", "--thread-info"];
const SURFACES = ["--background", "--sidebar", "--muted", "--card"];

describe("status colours as text", () => {
  for (const [name, theme] of [["dark", dark], ["light", light]] as const) {
    it(`reach 4.5:1 on every surface in the ${name} theme`, () => {
      for (const status of STATUS) {
        for (const surface of SURFACES) {
          const ratio = contrast(resolve(theme, `var(${status})`), resolve(theme, `var(${surface})`));
          expect({ status, surface, ok: ratio >= 4.5 }, `${status} on ${surface}: ${ratio.toFixed(2)}`).toEqual({ status, surface, ok: true });
        }
      }
    });
  }

  it("reads the tokens it checks", () => {
    expect(resolve(light, "var(--success)")).toBe(resolve(light, "var(--thread-success)"));
    expect(luminance(resolve(light, "var(--background)"))).toBeCloseTo(1, 3);
  });
});
