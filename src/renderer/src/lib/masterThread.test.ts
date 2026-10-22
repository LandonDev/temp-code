import { describe, expect, it } from "vitest";
import { isMasterThread, masterIdsOf, masterMenuLabel } from "./masterThread";

describe("isMasterThread", () => {
  it("reads the session's own flag", () => {
    expect(isMasterThread({ isMaster: true })).toBe(true);
    expect(isMasterThread({ isMaster: false })).toBe(false);
    expect(isMasterThread({ isMaster: null })).toBe(false);
    expect(isMasterThread({})).toBe(false);
  });
});

describe("masterIdsOf", () => {
  it("names every master, many per project, sorted", () => {
    expect(
      masterIdsOf([
        { id: "b", isMaster: true },
        { id: "x", isMaster: false },
        { id: "a", isMaster: true },
        { id: "y" },
      ]),
    ).toEqual(["a", "b"]);
  });
});

describe("masterMenuLabel", () => {
  it("offers the pin to a thread and the unpin to a master", () => {
    expect(masterMenuLabel(false)).toBe("Make master thread");
    expect(masterMenuLabel(true)).toBe("Not a master");
  });
});
