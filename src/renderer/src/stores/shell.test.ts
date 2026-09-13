import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveProjectRailOpen, saveSidebarOpen } from "../lib/appearance";
import { saveSettingsSection } from "../lib/settings";
import {
  applyLayoutChange,
  closeOverlays,
  closeViews,
  initialShellState,
  leaveToSessions,
  leaveTopOverlay,
  openFilesSearch,
  openInbox,
  openNotes,
  openSearchView,
  openSettings,
  openSymbolPicker,
  patch,
  settleSidebarTab,
  shell,
  shellStore,
  showSidebarTab,
  toggleSidebar,
} from "./shell";

vi.mock("../lib/appearance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/appearance")>()),
  saveSidebarOpen: vi.fn(),
  saveProjectRailOpen: vi.fn(),
}));
vi.mock("../lib/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/settings")>()),
  saveSettingsSection: vi.fn(),
}));

const base = () =>
  initialShellState({
    sidebarOpen: false,
    projectRailOpen: true,
    sidebarTab: "sessions",
    settingsSection: "general",
  });

describe("shell reducers", () => {
  it("a change already in place returns the same state", () => {
    const state = base();
    expect(patch(state, { sidebarOpen: false })).toBe(state);
    expect(closeViews(state)).toBe(state);
    expect(closeOverlays(state)).toBe(state);
    expect(leaveToSessions(state)).toBe(state);
    const shown = { ...state, sidebarOpen: true };
    expect(showSidebarTab(shown, "sessions")).toBe(shown);
    expect(leaveTopOverlay(state)).toBe(state);
    expect(settleSidebarTab(state, "deck")).toBe(state);
    expect(settleSidebarTab(state, "classic")).toBe(state);
    expect(applyLayoutChange(state, "classic")).toBe(state);
    expect(applyLayoutChange(state, "deck")).toBe(state);
  });

  it("the views are exclusive: opening one closes the others and the pickers", () => {
    const state = { ...base(), searchViewOpen: true, filePickerOpen: true, settingsOpen: true };
    const inbox = openInbox(state, "deck");
    expect(inbox).toMatchObject({
      inboxViewOpen: true,
      searchViewOpen: false,
      filePickerOpen: false,
      settingsOpen: false,
    });
    const notes = openNotes(inbox);
    expect(notes).toMatchObject({ notesViewOpen: true, inboxViewOpen: false });
    const settings = openSettings(notes, "editor");
    expect(settings).toMatchObject({
      settingsOpen: true,
      settingsSection: "editor",
      notesViewOpen: false,
    });
    expect(openSettings(settings)).toBe(settings);
    expect(openSettings(settings).settingsSection).toBe("editor");
  });

  it("classic has no inbox view: the sidebar's inbox tab opens instead", () => {
    const next = openInbox(base(), "classic");
    expect(next).toMatchObject({ inboxViewOpen: false, sidebarOpen: true, sidebarTab: "inbox" });
    expect(openInbox(next, "classic")).toBe(next);
  });

  it("find in project and search each bump their own focus token", () => {
    const files = openFilesSearch({ ...base(), inboxViewOpen: true });
    expect(files).toMatchObject({
      sidebarOpen: true,
      sidebarTab: "files",
      filesSearchOpen: true,
      searchFocusToken: 1,
      inboxViewOpen: false,
    });
    expect(openFilesSearch(files).searchFocusToken).toBe(2);
    const search = openSearchView(files);
    expect(search.searchViewFocusToken).toBe(1);
    expect(search.searchViewOpen).toBe(true);
    expect(search.searchFocusToken).toBe(1);
  });

  it("the symbol picker replaces the file picker", () => {
    const next = openSymbolPicker({ ...base(), filePickerOpen: true });
    expect(next).toMatchObject({ filePickerOpen: false, symbolPickerOpen: true });
  });

  it("toggling the sidebar flips the rail in deck and the sidebar in classic", () => {
    const state = base();
    expect(toggleSidebar(state, "deck")).toMatchObject({ projectRailOpen: false, sidebarOpen: false });
    expect(toggleSidebar(state, "classic")).toMatchObject({ projectRailOpen: true, sidebarOpen: true });
  });

  it("back closes the topmost overlay, settings before the views", () => {
    const all = {
      ...base(),
      settingsOpen: true,
      searchViewOpen: true,
      inboxViewOpen: true,
      notesViewOpen: true,
    };
    const one = leaveTopOverlay(all);
    expect(one.settingsOpen).toBe(false);
    expect(one.searchViewOpen).toBe(true);
    const two = leaveTopOverlay(one);
    expect(two.searchViewOpen).toBe(false);
    const three = leaveTopOverlay(two);
    expect(three.inboxViewOpen).toBe(false);
    const four = leaveTopOverlay(three);
    expect(four.notesViewOpen).toBe(false);
    expect(leaveTopOverlay(four)).toBe(four);
  });

  it("switching to classic moves an open inbox view into the sidebar", () => {
    const next = applyLayoutChange({ ...base(), inboxViewOpen: true, sidebarTab: "changes" }, "classic");
    expect(next).toMatchObject({ inboxViewOpen: false, sidebarOpen: true, sidebarTab: "inbox" });
    expect(applyLayoutChange({ ...base(), sidebarTab: "changes" }, "classic").sidebarTab).toBe("sessions");
    expect(applyLayoutChange({ ...base(), sidebarTab: "inbox" }, "deck").sidebarTab).toBe("sessions");
    expect(applyLayoutChange({ ...base(), sidebarTab: "files" }, "deck").sidebarTab).toBe("files");
  });
});

describe("shell store", () => {
  beforeEach(() => {
    shellStore.setState(base(), true);
  });

  it("a no-op action wakes no subscriber", () => {
    let fired = 0;
    const stop = shellStore.subscribe(() => {
      fired += 1;
    });
    shell.closeViews();
    shell.closeSettings();
    shell.setSidebarTab("sessions");
    shell.dismissUpdate();
    expect(fired).toBe(0);
    shell.openFilePicker();
    expect(fired).toBe(1);
    stop();
  });

  it("back reports whether it closed anything", () => {
    expect(shell.leaveTopOverlay()).toBe(false);
    shell.openSearchView();
    expect(shell.leaveTopOverlay()).toBe(true);
    expect(shellStore.getState().searchViewOpen).toBe(false);
    expect(shell.leaveTopOverlay()).toBe(false);
  });

  it("the panel choices persist, once per change, and nothing else does", () => {
    vi.mocked(saveSidebarOpen).mockClear();
    vi.mocked(saveProjectRailOpen).mockClear();
    vi.mocked(saveSettingsSection).mockClear();
    shell.openSearchView();
    shell.openSettings();
    shell.openNotes();
    expect(saveSidebarOpen).not.toHaveBeenCalled();
    expect(saveProjectRailOpen).not.toHaveBeenCalled();
    expect(saveSettingsSection).not.toHaveBeenCalled();
    shell.toggleSidebar("classic");
    shell.showSidebarTab("files");
    shell.openFilesSearch();
    expect(saveSidebarOpen).toHaveBeenCalledTimes(1);
    expect(saveSidebarOpen).toHaveBeenCalledWith(true);
    shell.toggleSidebar("deck");
    expect(saveProjectRailOpen).toHaveBeenCalledTimes(1);
    expect(saveProjectRailOpen).toHaveBeenCalledWith(false);
    shell.openSettings("editor");
    shell.selectSettingsSection("editor");
    expect(saveSettingsSection).toHaveBeenCalledTimes(1);
    expect(saveSettingsSection).toHaveBeenCalledWith("editor");
  });

  it("a selector subscription fires only for its slice", () => {
    const seen: boolean[] = [];
    const stop = shellStore.subscribe((s) => s.settingsOpen, (open) => seen.push(open));
    shell.openSearchView();
    shell.openSettings("editor");
    shell.selectSettingsSection("build");
    shell.closeSettings();
    expect(seen).toEqual([true, false]);
    expect(shellStore.getState().settingsSection).toBe("build");
    stop();
  });
});
