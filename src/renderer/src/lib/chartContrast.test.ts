import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrast, resolve, themes } from "./colourMath";

/**
 * A chart's series are thin marks (a 1.5px stroke, a 0.2 fill), so every
 * `--chart-*` token reaches the non-text bar of 3:1 on the surfaces a chart
 * sits on, in both themes (docs/DESIGN.md "Colour").
 */
const { dark, light } = themes(readFileSync(join(__dirname, "../index.css"), "utf8"));
const CHARTS = [1, 2, 3, 4].map((i) => `--chart-${i}`);
const SURFACES = ["--background", "--card"];

describe("chart colours", () => {
  for (const [name, theme] of [["dark", dark], ["light", light]] as const) {
    it(`reach 3:1 on the page and a card in the ${name} theme`, () => {
      for (const chart of CHARTS) {
        for (const surface of SURFACES) {
          const ratio = contrast(resolve(theme, `var(${chart})`), resolve(theme, `var(${surface})`));
          expect({ chart, surface, ok: ratio >= 3 }, `${chart} on ${surface}: ${ratio.toFixed(2)}`).toEqual({ chart, surface, ok: true });
        }
      }
    });
  }
});
