import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The status colours are text as often as they are fills (counts, "Failed",
 * "Needs you", a hunk's +n −n), so each reaches 4.5:1 as small text on every
 * surface it sits on, in both themes. The selected row's fill is `muted`.
 */
const css = readFileSync(join(__dirname, "../index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of every top-level block whose selector is exactly `selector`, in order. */
function declarations(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    // What precedes the block may be at-rules ending in ";": the selector is what follows the last.
    if (m[1].split(";").pop()!.trim() !== selector) continue;
    for (const decl of m[2].split(";")) {
      const at = decl.indexOf(":");
      if (at < 0) continue;
      const name = decl.slice(0, at).trim();
      if (name.startsWith("--")) out.set(name, decl.slice(at + 1).trim());
    }
  }
  return out;
}

const dark = declarations(":root");
const light = new Map([...dark, ...declarations("html.theme-light")]);

function resolve(theme: Map<string, string>, value: string): string {
  const v = /^var\((--[\w-]+)\)$/.exec(value.trim());
  return v ? resolve(theme, theme.get(v[1]) ?? "") : value.trim();
}

const linear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const clamp = (c: number): number => Math.min(1, Math.max(0, c));

/** Relative luminance of a hex or oklch() colour. */
function luminance(value: string): number {
  let rgb: number[];
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  const ok = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (hex) {
    rgb = [0, 2, 4].map((i) => linear(parseInt(hex[1].slice(i, i + 2), 16) / 255));
  } else if (ok) {
    const [L, C, H] = ok.slice(1).map(Number);
    const a = C * Math.cos((H * Math.PI) / 180);
    const b = C * Math.sin((H * Math.PI) / 180);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    rgb = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ].map(clamp);
  } else {
    throw new Error(`unparsed colour ${value}`);
  }
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

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
