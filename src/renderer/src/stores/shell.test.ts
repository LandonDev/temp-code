import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveProjectRailOpen } from "../lib/appearance";
import { saveSettingsSection } from "../lib/settings";
import {
  closeOverlays,
  closeViews,
  initialShellState,
  leaveTopOverlay,
  openFilesSearch,
  openInbox,
  openNotes,
  openSearchView,
  openSettings,
  openSymbolPicker,
  patch,
  shell,
  shellStore,
  toggleProjectRail,
} from "./shell";

vi.mock("../lib/appearance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/appearance")>()),
  saveProjectRailOpen: vi.fn(),
}));
vi.mock("../lib/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/settings")>()),
  saveSettingsSection: vi.fn(),
}));

const base = () =>
  initialShellState({
    projectRailOpen: true,
    settingsSection: "general",
  });

describe("shell reducers", () => {
  it("a change already in place returns the same state", () => {
    const state = base();
    expect(patch(state, { projectRailOpen: true })).toBe(state);
    expect(closeViews(state)).toBe(state);
    expect(closeOverlays(state)).toBe(state);
    expect(leaveTopOverlay(state)).toBe(state);
    expect(openInbox({ ...state, inboxViewOpen: true })).toEqual({ ...state, inboxViewOpen: true });
  });

  it("the views are exclusive: opening one closes the others and the pickers", () => {
    const state = { ...base(), searchViewOpen: true, filePickerOpen: true, settingsOpen: true };
    const inbox = openInbox(state);
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

  it("find in project opens the search view seeded with the file filter; search alone keeps no seed", () => {
    const files = openFilesSearch({ ...base(), inboxViewOpen: true });
    expect(files).toMatchObject({
      searchViewOpen: true,
      searchViewFocusToken: 1,
      searchSeed: "type:file ",
      inboxViewOpen: false,
    });
    expect(openFilesSearch(files).searchViewFocusToken).toBe(2);
    const search = openSearchView(files);
    expect(search.searchViewFocusToken).toBe(2);
    expect(search.searchViewOpen).toBe(true);
    expect(search.searchSeed).toBeNull();
  });

  it("the symbol picker replaces the file picker", () => {
    const next = openSymbolPicker({ ...base(), filePickerOpen: true });
    expect(next).toMatchObject({ filePickerOpen: false, symbolPickerOpen: true });
  });

  it("toggling the sidebar flips the project rail", () => {
    expect(toggleProjectRail(base())).toMatchObject({ projectRailOpen: false });
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
    vi.mocked(saveProjectRailOpen).mockClear();
    vi.mocked(saveSettingsSection).mockClear();
    shell.openSearchView();
    shell.openSettings();
    shell.openNotes();
    expect(saveProjectRailOpen).not.toHaveBeenCalled();
    expect(saveSettingsSection).not.toHaveBeenCalled();
    shell.openFilesSearch();
    expect(saveProjectRailOpen).not.toHaveBeenCalled();
    shell.toggleProjectRail();
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
