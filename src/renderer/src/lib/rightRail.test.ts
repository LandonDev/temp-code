import { describe, expect, it } from "vitest";
import { isRightRailOpen, setRightRailOpen, toggleRightRail } from "./rightRail";

describe("rightRail", () => {
  it("starts closed and toggles", () => {
    setRightRailOpen(false);
    expect(isRightRailOpen()).toBe(false);
    toggleRightRail();
    expect(isRightRailOpen()).toBe(true);
    setRightRailOpen(true);
    expect(isRightRailOpen()).toBe(true);
    toggleRightRail();
    expect(isRightRailOpen()).toBe(false);
  });
});
