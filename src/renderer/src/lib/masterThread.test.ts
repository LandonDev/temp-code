import { describe, expect, it } from "vitest";
import { isMasterThread } from "./masterThread";

describe("isMasterThread", () => {
  const projects = [
    { id: "p1", masterThreadId: "m" },
    { id: "p2", masterThreadId: null },
    { id: "p3" },
  ];
  it("is true only for the session the project pins", () => {
    expect(isMasterThread({ id: "m", projectId: "p1" }, projects)).toBe(true);
    expect(isMasterThread({ id: "x", projectId: "p1" }, projects)).toBe(false);
  });
  it("is false with no pin, an absent pin, no project or an unknown project", () => {
    expect(isMasterThread({ id: "m", projectId: "p2" }, projects)).toBe(false);
    expect(isMasterThread({ id: "m", projectId: "p3" }, projects)).toBe(false);
    expect(isMasterThread({ id: "m", projectId: null }, projects)).toBe(false);
    expect(isMasterThread({ id: "m" }, projects)).toBe(false);
    expect(isMasterThread({ id: "m", projectId: "p9" }, projects)).toBe(false);
  });
});
