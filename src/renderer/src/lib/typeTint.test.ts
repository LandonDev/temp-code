import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrast, hueDistance, resolve, themes } from "./colourMath";

/**
 * A thread type's tint colours its glyph and nothing else (docs/DESIGN.md
 * "Type tints"): it reaches the non-text bar of 3:1 on every surface a glyph
 * sits on, and it stays clear of StatusMark's amber and red, so a type never
 * reads as Needs you or Failed.
 */
const { dark, light } = themes(readFileSync(join(__dirname, "../index.css"), "utf8"));

const TYPES = ["chat", "planning", "project-plan", "implementation", "orchestration", "research"].map((t) => `--type-${t}`);
const SURFACES = ["--background", "--sidebar", "--muted", "--card"];
const STATUSES = ["--thread-warning", "--thread-danger"];

// v1.0.303's THREAD_TINTS values; orchestration alone moved off amber.
const V303 = {
  dark: { "--type-chat": "#60a5fa", "--type-planning": "#a78bfa", "--type-implementation": "#34d399", "--type-research": "#22d3ee" },
  light: { "--type-chat": "#2563eb", "--type-planning": "#7c3aed", "--type-implementation": "#059669", "--type-research": "#0891b2" },
};

describe("type tints", () => {
  for (const [name, theme] of [["dark", dark], ["light", light]] as const) {
    it(`reach 3:1 on every surface in the ${name} theme`, () => {
      for (const type of TYPES) {
        for (const surface of SURFACES) {
          const ratio = contrast(resolve(theme, `var(${type})`), resolve(theme, `var(${surface})`));
          expect({ type, surface, ok: ratio >= 3 }, `${type} on ${surface}: ${ratio.toFixed(2)}`).toEqual({ type, surface, ok: true });
        }
      }
    });

    it(`stay 30° of OKLCH hue from amber and red in the ${name} theme`, () => {
      for (const type of TYPES) {
        for (const status of STATUSES) {
          const degrees = hueDistance(resolve(theme, `var(${type})`), resolve(theme, `var(${status})`));
          expect({ type, status, ok: degrees >= 30 }, `${type} from ${status}: ${degrees.toFixed(1)}°`).toEqual({ type, status, ok: true });
        }
      }
    });

    it(`keep v1.0.303's values in the ${name} theme`, () => {
      for (const [type, value] of Object.entries(V303[name])) expect(resolve(theme, `var(${type})`), type).toBe(value);
    });
  }

  it("draws a project plan in planning's colour", () => {
    for (const theme of [dark, light]) expect(resolve(theme, "var(--type-project-plan)")).toBe(resolve(theme, "var(--type-planning)"));
  });

  it("holds literals, so a status colour's retune never moves a type", () => {
    for (const type of TYPES.filter((t) => t !== "--type-project-plan")) {
      expect(dark.get(type), type).toMatch(/^#[0-9a-f]{6}$/);
      expect(light.get(type), type).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
