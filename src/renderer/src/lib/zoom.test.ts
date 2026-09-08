import { describe, expect, it } from "vitest";
import { clampZoom, stepZoom } from "./zoom";

describe("zoom", () => {
  it("steps by a tenth and clamps to the range", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1.1, 1)).toBe(1.2);
    expect(stepZoom(0.5, -1)).toBe(0.5);
    expect(stepZoom(2, 1)).toBe(2);
  });

  it("rounds away float drift", () => {
    expect(clampZoom(0.7 + 0.2)).toBe(0.9);
    expect(clampZoom(1.0000001)).toBe(1);
  });
});
