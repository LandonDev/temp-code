import { describe, expect, it } from "vitest";
import { sidebarVisible, type SidebarVisibilityInput } from "./sidebarVisibility";

const deck = (over: Partial<SidebarVisibilityInput> = {}): SidebarVisibilityInput => ({
  open: true,
  deckLayout: true,
  inProject: true,
  atHome: false,
  searchActive: false,
  inboxActive: false,
  notesActive: false,
  accountsPage: false,
  settingsOpen: false,
  ...over,
});
const classic = (over: Partial<SidebarVisibilityInput> = {}): SidebarVisibilityInput =>
  deck({ deckLayout: false, ...over });

describe("sidebarVisible", () => {
  it("shows the aside on the board in both layouts", () => {
    expect(sidebarVisible(deck())).toBe(true);
    expect(sidebarVisible(classic())).toBe(true);
    expect(sidebarVisible(classic({ open: false }))).toBe(false);
  });

  it("the Aliax pages fill the window like the other views, in both layouts", () => {
    for (const view of ["accountsPage", "searchActive", "inboxActive", "notesActive"] as const) {
      expect(sidebarVisible(deck({ [view]: true }))).toBe(false);
      expect(sidebarVisible(classic({ [view]: true }))).toBe(false);
    }
  });

  it("closing an Aliax page brings the aside back as it was", () => {
    const before = deck();
    expect(sidebarVisible({ ...before, accountsPage: true })).toBe(false);
    expect(sidebarVisible(before)).toBe(true);
    const blank = deck({ inProject: false });
    expect(sidebarVisible({ ...blank, accountsPage: true })).toBe(false);
    expect(sidebarVisible(blank)).toBe(false);
  });

  it("classic settings keep the aside for the section nav; deck settings stand alone", () => {
    expect(sidebarVisible(classic({ settingsOpen: true }))).toBe(true);
    expect(sidebarVisible(deck({ settingsOpen: true }))).toBe(false);
  });

  it("a blank deck session stands alone unless it is the home", () => {
    expect(sidebarVisible(deck({ inProject: false }))).toBe(false);
    expect(sidebarVisible(deck({ inProject: false, atHome: true }))).toBe(true);
  });
});
