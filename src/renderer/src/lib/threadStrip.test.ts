import { describe, expect, it } from "vitest";
import { neighbourAfterArchive, splitStrip, stripOrder } from "./threadStrip";

const tabs = [
  { id: "a", updatedAt: 10 },
  { id: "b", dormant: true, updatedAt: 40 },
  { id: "c", updatedAt: 30 },
  { id: "d", dormant: true, updatedAt: 20 },
];

describe("splitStrip", () => {
  it("puts live chips first and orders each row freshest first", () => {
    const { live, dorm } = splitStrip(tabs);
    expect(live.map((t) => t.id)).toEqual(["c", "a"]);
    expect(dorm.map((t) => t.id)).toEqual(["b", "d"]);
  });

  it("keeps a selected dormant chip on the shelf", () => {
    const { live, dorm } = splitStrip([{ id: "x", dormant: true }]);
    expect(live).toEqual([]);
    expect(dorm.map((t) => t.id)).toEqual(["x"]);
  });

  it("treats a missing updatedAt as oldest and keeps input order for ties", () => {
    const { live } = splitStrip([{ id: "p" }, { id: "q", updatedAt: 1 }, { id: "r" }]);
    expect(live.map((t) => t.id)).toEqual(["q", "p", "r"]);
  });
});

describe("stripOrder", () => {
  it("walks the live row then the shelf", () => {
    expect(stripOrder(tabs).map((t) => t.id)).toEqual(["c", "a", "b", "d"]);
  });
});

describe("neighbourAfterArchive", () => {
  it("hands selection to the chip in the same slot, or the last one", () => {
    expect(neighbourAfterArchive(tabs, "c")?.id).toBe("a");
    expect(neighbourAfterArchive(tabs, "d")?.id).toBe("b");
    expect(neighbourAfterArchive(tabs, "a")?.id).toBe("b");
  });

  it("returns null when the archived chip was the only one", () => {
    expect(neighbourAfterArchive([{ id: "only" }], "only")).toBeNull();
  });
});
