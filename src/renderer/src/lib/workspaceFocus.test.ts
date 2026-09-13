import { describe, expect, it } from "vitest";
import { newFileTab, newTab, openEditorTab, splitPane } from "./layout";
import {
  focusDiff,
  focusPane,
  setTabSplitRatio,
  tabSurfacePanes,
} from "./workspaceFocus";

function tabs() {
  const a = newTab("s1");
  const b = newTab("s2");
  return [a, b];
}

function splitTab(tab = newTab("s1")) {
  return { ...tab, layout: splitPane(tab.layout, "s1", "right", "s3") };
}

describe("focusPane", () => {
  it("returns the same array when the pane is already focused", () => {
    const list = tabs();
    expect(focusPane(list, "s1", "s1")).toBe(list);
  });

  it("still clears the diff when the pane already holds focus", () => {
    const list = [{ ...newTab("s1"), diffFocused: true }];
    const next = focusPane(list, list[0].id, "s1");
    expect(next).not.toBe(list);
    expect(next[0].diffFocused).toBe(false);
  });

  it("returns the same array for an unknown tab", () => {
    const list = tabs();
    expect(focusPane(list, "nope", "s1")).toBe(list);
  });

  it("moves focus and clears the diff, touching only the active tab", () => {
    const list = tabs();
    const withDiff = { ...splitTab(list[0]), diffFocused: true };
    const next = focusPane([withDiff, list[1]], withDiff.id, "s3");
    expect(next[0].focusedId).toBe("s3");
    expect(next[0].diffFocused).toBe(false);
    expect(next[1]).toBe(list[1]);
  });
});

describe("focusDiff", () => {
  it("is identity when the diff already has focus", () => {
    const list = [{ ...newTab("s1"), diffFocused: true }];
    expect(focusDiff(list, list[0].id)).toBe(list);
  });

  it("marks the diff focused otherwise", () => {
    const list = tabs();
    expect(focusDiff(list, list[1].id)[1].diffFocused).toBe(true);
  });
});

describe("setTabSplitRatio", () => {
  it("is identity for a leaf layout and for a missing split", () => {
    const list = tabs();
    expect(setTabSplitRatio(list, list[0].id, "x", 0, 0.5)).toBe(list);
    const split = [splitTab(list[0])];
    expect(setTabSplitRatio(split, split[0].id, "missing", 0, 0.5)).toBe(split);
  });

  it("returns a new tab when the ratio moves, and the same one when it does not", () => {
    const split = [splitTab()];
    const layout = split[0].layout;
    if (layout.type !== "split") throw new Error("expected a split");
    const next = setTabSplitRatio(split, split[0].id, layout.id, 0, 0.3);
    expect(next).not.toBe(split);
    expect(next[0].layout).not.toBe(layout);
    expect(setTabSplitRatio(next, next[0].id, layout.id, 0, 0.3)).toBe(next);
  });
});

describe("tabSurfacePanes", () => {
  it("caches per tab record and includes terminal panes", () => {
    const tab = openEditorTab(newTab("s1"), newFileTab("/tmp/a.ts", "/tmp"));
    const first = tabSurfacePanes(tab);
    expect(tabSurfacePanes(tab)).toBe(first);
    expect(first).toHaveLength(tab.editorPanes.length + tab.terminalPanes.length);
    expect(tabSurfacePanes({ ...tab })).not.toBe(first);
  });
});
