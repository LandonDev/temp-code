import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrast, luminance, resolve, themes } from "./colourMath";

/**
 * The status colours are text as often as they are fills (counts, "Failed",
 * "Needs you", a hunk's +n −n), so each reaches 4.5:1 as small text on every
 * surface it sits on, in both themes. The selected row's fill is `muted`.
 * A project card's fills (`sidebar-group*`) carry amber, red and green text
 * (its count line and tallies); the info blue is never text in the workspace
 * column, so it is held to the group fills only as a glyph (3:1).
 */
const { dark, light } = themes(readFileSync(join(__dirname, "../index.css"), "utf8"));

const STATUS = ["--thread-success", "--thread-warning", "--thread-danger", "--thread-info"];
const SURFACES = ["--background", "--sidebar", "--muted", "--card"];
const GROUP_SURFACES = ["--sidebar-group", "--sidebar-group-hover", "--sidebar-group-selected"];
const ON_GROUP = (status: string): boolean => status !== "--thread-info";

describe("status colours as text", () => {
  for (const [name, theme] of [["dark", dark], ["light", light]] as const) {
    it(`reach 4.5:1 on every surface in the ${name} theme`, () => {
      for (const status of STATUS) {
        for (const surface of ON_GROUP(status) ? [...SURFACES, ...GROUP_SURFACES] : SURFACES) {
          const ratio = contrast(resolve(theme, `var(${status})`), resolve(theme, `var(${surface})`));
          expect({ status, surface, ok: ratio >= 4.5 }, `${status} on ${surface}: ${ratio.toFixed(2)}`).toEqual({ status, surface, ok: true });
        }
      }
    });
  }

  it("holds the info blue to 3:1 on a project card's fills", () => {
    for (const theme of [dark, light]) {
      for (const surface of GROUP_SURFACES) expect(contrast(resolve(theme, "var(--thread-info)"), resolve(theme, `var(${surface})`)), surface).toBeGreaterThanOrEqual(3);
    }
  });

  it("reads the tokens it checks", () => {
    expect(resolve(light, "var(--success)")).toBe(resolve(light, "var(--thread-success)"));
    expect(luminance(resolve(light, "var(--background)"))).toBeCloseTo(1, 3);
  });
});
