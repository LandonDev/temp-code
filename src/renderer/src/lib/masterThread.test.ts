import { describe, expect, it } from "vitest";
import { isMasterThread } from "./masterThread";

describe("isMasterThread", () => {
  it("is true for a root thread carrying the flag", () => {
    expect(isMasterThread({ isMaster: true, parentId: null })).toBe(true);
    expect(isMasterThread({ isMaster: true })).toBe(true);
  });
  it("is false without the flag, and for a subagent whatever its flag", () => {
    expect(isMasterThread({ isMaster: false, parentId: null })).toBe(false);
    expect(isMasterThread({})).toBe(false);
    expect(isMasterThread({ isMaster: true, parentId: "m" })).toBe(false);
  });
});
