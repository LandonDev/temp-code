import { describe, expect, it } from "vitest";
import { sidebarVisible, type SidebarVisibilityInput } from "./sidebarVisibility";

const input = (over: Partial<SidebarVisibilityInput> = {}): SidebarVisibilityInput => ({
  inProject: true,
  atHome: false,
  searchActive: false,
  inboxActive: false,
  notesActive: false,
  accountsPage: false,
  settingsOpen: false,
  ...over,
});

describe("sidebarVisible", () => {
  it("shows the workspace column on a workspace", () => {
    expect(sidebarVisible(input())).toBe(true);
  });

  it("the full-window views and settings cover it", () => {
    for (const view of ["accountsPage", "searchActive", "inboxActive", "notesActive", "settingsOpen"] as const) {
      expect(sidebarVisible(input({ [view]: true }))).toBe(false);
    }
  });

  it("closing an Aliax page brings the column back as it was", () => {
    const before = input();
    expect(sidebarVisible({ ...before, accountsPage: true })).toBe(false);
    expect(sidebarVisible(before)).toBe(true);
    const blank = input({ inProject: false });
    expect(sidebarVisible({ ...blank, accountsPage: true })).toBe(false);
    expect(sidebarVisible(blank)).toBe(false);
  });

  it("a blank session stands alone unless it is the home", () => {
    expect(sidebarVisible(input({ inProject: false }))).toBe(false);
    expect(sidebarVisible(input({ inProject: false, atHome: true }))).toBe(true);
  });
});
