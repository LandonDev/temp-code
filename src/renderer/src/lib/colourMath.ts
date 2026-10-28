/**
 * Colour arithmetic over index.css's token layer, for the tests that hold
 * the tokens to their contrast and hue rules (statusContrast, typeTint).
 * Parses `#rrggbb` and `oklch(L C H)`; follows `var(--name)` through a theme.
 */

export type Theme = Map<string, string>;

/** The custom properties of every top-level block whose selector is exactly `selector`, in order. */
export function declarations(css: string, selector: string): Theme {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Theme = new Map();
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
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

/** The dark theme (`:root`) and the light one (`:root` overlaid by `html.theme-light`). */
export function themes(css: string): { dark: Theme; light: Theme } {
  const dark = declarations(css, ":root");
  return { dark, light: new Map([...dark, ...declarations(css, "html.theme-light")]) };
}

export function resolve(theme: Theme, value: string): string {
  const v = /^var\((--[\w-]+)\)$/.exec(value.trim());
  return v ? resolve(theme, theme.get(v[1]) ?? "") : value.trim();
}

const linear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const clamp = (c: number): number => Math.min(1, Math.max(0, c));

/** OKLab of a hex colour, or of an oklch() one. */
export function oklab(value: string): [number, number, number] {
  const ok = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (ok) {
    const [L, C, H] = ok.slice(1).map(Number);
    return [L, C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180)];
  }
  const [r, g, b] = linearRgb(value);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Linear sRGB of a hex or oklch() colour, clamped to the gamut. */
function linearRgb(value: string): number[] {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map((i) => linear(parseInt(hex[1].slice(i, i + 2), 16) / 255));
  if (!/^oklch\(/.test(value)) throw new Error(`unparsed colour ${value}`);
  const [L, a, b] = oklab(value);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(clamp);
}

/** Relative luminance of a hex or oklch() colour. */
export function luminance(value: string): number {
  const [r, g, b] = linearRgb(value);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** OKLCH hue in degrees, 0 to 360. */
export function hue(value: string): number {
  const [, a, b] = oklab(value);
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
}

/** The shorter way round the hue circle between two colours, in degrees. */
export function hueDistance(x: string, y: string): number {
  const d = Math.abs(hue(x) - hue(y));
  return Math.min(d, 360 - d);
}
