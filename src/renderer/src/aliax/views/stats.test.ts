import { describe, expect, it } from "vitest";
import type { PaceSeries } from "@shared/aliaxStats";
import { paceLine, timeLeft } from "./stats";

const HOUR = 3_600_000;
/** A 5-hour window `left` hours from its end, heading for `projected` percent. */
const pace = (left: number, projected: number): PaceSeries =>
  ({ periodMs: 5 * HOUR, nowFrac: 1 - left / 5, projectedPercent: projected }) as unknown as PaceSeries;

describe("Stats pace line", () => {
  it("says one hour in the singular, more in the plural", () => {
    expect(paceLine(pace(1.2, 40)).text).toBe("Ends near 40% at this pace, 1 hour left");
    expect(paceLine(pace(2, 120)).text).toBe("Will run out, 2 hours left");
  });

  it("rounds before it picks the word", () => {
    expect(timeLeft(1.4)).toBe("1 hour");
    expect(timeLeft(1.6)).toBe("2 hours");
    expect(timeLeft(0.5)).toBe("under an hour");
    expect(timeLeft(72)).toBe("3 days");
  });
});
