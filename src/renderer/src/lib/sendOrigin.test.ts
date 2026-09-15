import { afterEach, describe, expect, it } from "vitest";
import { recordSendOrigin, resetSendOrigin, sendOffset, sendOrigin } from "./sendOrigin";

const rect = (top: number, left: number) =>
  ({ top, left, width: 640, height: 44 }) as DOMRect;

describe("sendOrigin", () => {
  afterEach(resetSendOrigin);

  it("is fresh for a second, then gone", () => {
    recordSendOrigin(rect(700, 300), 1000);
    expect(sendOrigin(1500)?.top).toBe(700);
    expect(sendOrigin(2001)).toBeNull();
  });

  it("offsets the bubble from its rest box toward the field", () => {
    expect(sendOffset({ top: 700, left: 300, width: 0, height: 0, at: 0 }, { top: 400, left: 420 })).toEqual({
      dx: -120,
      dy: 300,
    });
  });

  it("falls back to the plain rise without an origin or past the cap", () => {
    expect(sendOffset(null, { top: 0, left: 0 })).toBeNull();
    expect(sendOffset({ top: 1300, left: 0, width: 0, height: 0, at: 0 }, { top: 0, left: 0 })).toBeNull();
    expect(sendOffset({ top: 600, left: 0, width: 0, height: 0, at: 0 }, { top: 0, left: 0 })).toEqual({
      dx: 0,
      dy: 600,
    });
  });
});
