import { describe, expect, it } from "vitest";
import { pushSample, releaseVelocity, rubber, rubberband, type DragSample } from "./drag";

describe("rubber", () => {
  it("follows the pointer inside the bounds and stretches ever more reluctantly past them", () => {
    expect(rubber(150, 100, 200)).toBe(150);
    const a = rubber(250, 100, 200) - 200;
    const b = rubber(300, 100, 200) - 250;
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(50);
    expect(b).toBeLessThan(a);
    expect(rubber(50, 100, 200)).toBeCloseTo(100 - rubberband(50));
    expect(rubberband(1e9)).toBeLessThan(300 / 0.55 + 1);
  });
});

describe("releaseVelocity", () => {
  const samples = (...pairs: [number, number][]): DragSample[] => pairs.map(([at, t]) => ({ at, t }));

  it("reads px/s over the last 100ms of readings", () => {
    // 20px in the last 40ms: 500px/s; the reading 200ms back is past the window.
    expect(releaseVelocity(samples([0, 0], [100, 200], [110, 220], [120, 240]), 245)).toBeCloseTo(500);
    expect(releaseVelocity(samples([300, 0], [280, 20]), 20)).toBeCloseTo(-1000);
  });

  it("has no speed for a pointer that rested before it let go, or with one reading", () => {
    expect(releaseVelocity(samples([0, 0], [50, 50]), 400)).toBe(0);
    expect(releaseVelocity(samples([10, 5]), 5)).toBe(0);
    expect(releaseVelocity([], 5)).toBe(0);
    expect(releaseVelocity(samples([0, 0], [50, 50]), Infinity)).toBe(0);
  });

  it("keeps the last few readings only", () => {
    const list: DragSample[] = [];
    for (let i = 0; i < 20; i++) pushSample(list, i, i);
    expect(list).toHaveLength(6);
    expect(list[5]).toEqual({ at: 19, t: 19 });
  });
});
