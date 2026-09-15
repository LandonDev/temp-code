import { describe, expect, it } from "vitest";
import { subagentRowsOpen, toggleSubagentRows } from "./subagentRows";

describe("subagent rows", () => {
  it("follow the work until pinned", () => {
    const none = { pinned: {} };
    expect(subagentRowsOpen(none, "r", true)).toBe(true);
    expect(subagentRowsOpen(none, "r", false)).toBe(false);
  });

  it("a pin outlives the work, and flipping back to the work's state drops it", () => {
    const opened = toggleSubagentRows({ pinned: {} }, "r", false);
    expect(opened.pinned).toEqual({ r: true });
    expect(subagentRowsOpen(opened, "r", false)).toBe(true);
    expect(subagentRowsOpen(opened, "r", true)).toBe(true);
    // Folding a working root pins it shut; unfolding it again clears the pin.
    const shut = toggleSubagentRows({ pinned: {} }, "r", true);
    expect(shut.pinned).toEqual({ r: false });
    expect(toggleSubagentRows(shut, "r", true).pinned).toEqual({});
  });
});
