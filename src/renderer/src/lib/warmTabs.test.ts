import { describe, expect, it } from "vitest";
import { newTab, newTerminalFile, type WorkspaceTab } from "./layout";
import { emptyTabVisitHistory } from "./tabVisitHistory";
import { mountTab, trimMounted, warmTabIds } from "./warmTabs";

const tab = (id: string): WorkspaceTab => ({ ...newTab(`s-${id}`), id });

describe("warmTabIds", () => {
  it("keeps the active tab and the two most recently active others, newest first", () => {
    const tabs = ["a", "b", "c", "d", "e"].map(tab);
    const visits = { back: ["a", "b", "c", "d"], forward: [], current: "e" };
    expect(warmTabIds(tabs, "e", visits)).toEqual(["e", "d", "c"]);
  });

  it("counts a tab once however often the trail visited it", () => {
    const tabs = ["a", "b", "c"].map(tab);
    const visits = { back: ["a", "b", "a", "b"], forward: [], current: "c" };
    expect(warmTabIds(tabs, "c", visits)).toEqual(["c", "b", "a"]);
  });

  it("skips closed tabs and the active one in the trail, and reads the forward stack too", () => {
    const tabs = ["a", "b", "c"].map(tab);
    const visits = { back: ["gone", "c"], forward: ["b"], current: "a" };
    expect(warmTabIds(tabs, "a", visits)).toEqual(["a", "c", "b"]);
    expect(warmTabIds(tabs, "a", emptyTabVisitHistory("a"))).toEqual(["a"]);
  });

  it("never unmounts a tab whose panes hold a terminal or an editor", () => {
    const term: WorkspaceTab = {
      ...newTab("s-t"),
      id: "t",
      terminalPanes: [{ id: "p", files: [newTerminalFile("/repo", "zsh")], activeFileId: "" }],
    };
    const tabs = [tab("a"), tab("b"), tab("c"), term];
    const visits = { back: ["t", "a", "b"], forward: [], current: "c" };
    expect(warmTabIds(tabs, "c", visits)).toEqual(["c", "b", "a", "t"]);
    expect(warmTabIds(tabs, "c", visits, 0)).toEqual(["c", "t"]);
  });
});

describe("mountTab / trimMounted", () => {
  it("add once and drop to the kept set, returning the same array for a no-op", () => {
    const mounted = ["a", "b"];
    expect(mountTab(mounted, "a")).toBe(mounted);
    expect(mountTab(mounted, "")).toBe(mounted);
    expect(mountTab(mounted, "c")).toEqual(["a", "b", "c"]);
    expect(trimMounted(mounted, ["b", "a"])).toBe(mounted);
    expect(trimMounted(mounted, ["b"])).toEqual(["b"]);
  });
});
