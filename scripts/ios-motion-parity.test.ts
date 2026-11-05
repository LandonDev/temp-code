import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DUR, EASE_DRAWER, EASE_EXIT, EASE_IN_OUT, EASE_OUT, EASE_SWAP, FOLD_HOLD_MS, MARK, REVEAL, SHIMMER, SPINNER_TURN, SPRING_GLIDE, SPRING_LAYOUT, springEasing } from "../src/renderer/src/lib/ease";
import { WORD_HOLD_MS } from "../src/renderer/src/lib/heldWord";
import { COPIED_MS } from "../src/renderer/src/lib/clipboard";
import { STALE_WATCH_MS } from "../src/shared/watch";

/* The phone holds the desktop's motion numbers once, in the client
 * package's MotionValues.swift (docs/IOS-DESIGN.md "Motion"). This reads
 * that file and fails when a value differs from index.css, lib/ease.ts and
 * the holds, so a desktop change that the phone has not taken shows here. */
const ROOT = resolve(__dirname, "..");
const swift = readFileSync(resolve(ROOT, "ios/TempCodeClient/Sources/TempCodeClient/Design/MotionValues.swift"), "utf8");
const css = readFileSync(resolve(ROOT, "src/renderer/src/index.css"), "utf8");

type Value = number | number[] | { stiffness: number; damping: number; mass: number };

export function swiftValues(text: string): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const m of text.matchAll(/public static let (\w+)(?::\s*\w+)?\s*=\s*([^\n]+)/g)) {
    const [, name, raw] = m;
    const curve = raw.match(/^Curve\(([^)]*)\)/);
    const spring = raw.match(/^Spring\(stiffness:\s*([\d.]+),\s*damping:\s*([\d.]+),\s*mass:\s*([\d.]+)\)/);
    if (curve) out[name] = curve[1].split(",").map(Number);
    else if (spring) out[name] = { stiffness: +spring[1], damping: +spring[2], mass: +spring[3] };
    else if (/^-?[\d.]+$/.test(raw.trim())) out[name] = Number(raw.trim());
  }
  return out;
}

function cssMs(name: string): number {
  const m = css.match(new RegExp(`--${name}:\\s*(\\d+)ms`));
  if (!m) throw new Error(`index.css has no --${name}`);
  return Number(m[1]) / 1000;
}

function cssCurve(name: string): number[] {
  const m = css.match(new RegExp(`--${name}:\\s*cubic-bezier\\(([^)]*)\\)`));
  if (!m) throw new Error(`index.css has no --${name} curve`);
  return m[1].split(",").map(Number);
}

const bezierOf = (easing: unknown) => String(easing).match(/cubic-bezier\(([^)]*)\)/)![1].split(",").map(Number);
const offsetOf = (frames: Keyframe[], at: number) => frames[at].offset as number;

const phone = swiftValues(swift);

describe("the phone's motion values", () => {
  it("are parsed, every one", () => {
    expect(Object.keys(phone).length).toBeGreaterThan(30);
  });

  it("take the desktop's durations", () => {
    expect(phone.swapOut).toBe(cssMs("dur-swap-out"));
    expect(phone.fast).toBe(cssMs("dur-fast"));
    expect(phone.base).toBe(cssMs("dur-base"));
    expect(phone.slow).toBe(cssMs("dur-slow"));
    expect(phone.drawer).toBe(cssMs("dur-drawer"));
    expect(phone.layout).toBe(cssMs("dur-layout"));
    expect([phone.swapOut, phone.fast, phone.base, phone.slow, phone.drawer]).toEqual([DUR.swapOut, DUR.fast, DUR.base, DUR.slow, DUR.drawer]);
  });

  it("take the desktop's curves", () => {
    expect(phone.easeOut).toEqual([...EASE_OUT]);
    expect(phone.easeOut).toEqual(cssCurve("ease-out"));
    expect(phone.easeInOut).toEqual([...EASE_IN_OUT]);
    expect(phone.easeDrawer).toEqual([...EASE_DRAWER]);
    expect(phone.easeExit).toEqual([...EASE_EXIT]);
    expect(phone.easeSwap).toEqual([...EASE_SWAP]);
    expect(phone.easeSwap).toEqual(cssCurve("ease-swap"));
    expect(phone.easeBreathe).toEqual(cssCurve("ease-breathe"));
    expect(phone.shimmerSweep).toEqual(bezierOf(SHIMMER.band[1].easing));
  });

  it("take the desktop's springs, and the layout spring settles in --dur-layout", () => {
    const strip = ({ stiffness, damping, mass }: typeof SPRING_LAYOUT) => ({ stiffness, damping, mass });
    expect(phone.springLayout).toEqual(strip(SPRING_LAYOUT));
    expect(phone.springGlide).toEqual(strip(SPRING_GLIDE));
    expect(springEasing(SPRING_LAYOUT).ms / 1000).toBe(phone.layout);
  });

  it("take the stream's reveal and the holds", () => {
    expect(phone.revealStep).toBe(REVEAL.stepMs / 1000);
    expect(phone.revealFade).toBe(REVEAL.fadeMs / 1000);
    expect(phone.revealFade).toBe(cssMs("dur-reveal"));
    expect(phone.longToken).toBe(REVEAL.longTokenChars);
    expect(phone.wordHold).toBe(WORD_HOLD_MS / 1000);
    expect(phone.foldHold).toBe(FOLD_HOLD_MS / 1000);
    expect(phone.copied).toBe(COPIED_MS / 1000);
    expect(phone.staleWatch).toBe(STALE_WATCH_MS / 1000);
  });

  it("take the loops: the shimmer, the working mark and the spinner", () => {
    expect(phone.shimmerPeriod).toBe(Number(SHIMMER.timing.duration) / 1000);
    expect(phone.shimmerStart).toBe(offsetOf(SHIMMER.band, 1));
    expect(phone.shimmerEnd).toBe(offsetOf(SHIMMER.band, 2));
    expect(phone.markPeriod).toBe(Number(MARK.timing.duration) / 1000);
    const [left, middle, right] = MARK.dots;
    expect(String(left[0].transform)).toContain(`translateX(-${phone.markSpread}px)`);
    expect(String(left[1].transform)).toContain(`scale(${phone.markSideScale})`);
    expect(String(middle[1].transform)).toContain(`scale(${phone.markMiddleScale})`);
    expect([offsetOf(left, 1), offsetOf(left, 2)]).toEqual([phone.markGather, phone.markPart]);
    expect([offsetOf(right, 1), offsetOf(right, 2)]).toEqual([phone.markLagGather, phone.markLagPart]);
    expect(phone.spinnerTurn).toBe(Number(SPINNER_TURN.timing.duration) / 1000);
  });
});
