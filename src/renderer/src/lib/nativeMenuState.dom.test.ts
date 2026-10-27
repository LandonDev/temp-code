// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shellStore } from "../stores/shell";
import { MENU_STATE_CLOCK_MS, MENU_STATE_THROTTLE_MS, menuStateOf, publishMenuState, type MenuFacts } from "./nativeMenuState";
import { rightPanel } from "./rightPanel";
import { sessionStore } from "./tcserver/store";
import type { SessionMeta } from "./tcserver/types";
import { workspaceStore } from "./tcserver/workspaces";

const NONE = { pause: 0, resume: 0, stop: 0, archiveDone: 0 };
const facts = (over: Partial<MenuFacts> = {}): MenuFacts => ({
  sidebarOpen: false,
  panel: "closed",
  dockOpen: false,
  split: false,
  dockUsable: true,
  notesEnabled: true,
  unread: 1,
  counts: { pause: 1, resume: 1, stop: 1, archiveDone: 1 },
  ...over,
});

describe("menuStateOf", () => {
  it("opens each toggle the window shows", () => {
    expect(menuStateOf(facts({ sidebarOpen: true, panel: "open", dockOpen: true }))).toEqual({
      open: ["toggle_sidebar", "toggle_panel", "toggle_terminal"],
      disabled: [],
    });
    expect(menuStateOf(facts())).toEqual({ open: [], disabled: [] });
  });

  it("names ⌘W Close Pane while the active tab is split", () => {
    expect(menuStateOf(facts({ split: true })).open).toEqual(["close_tab"]);
  });

  it("greys the panel with no root thread on screen and the terminal outside a project", () => {
    expect(menuStateOf(facts({ panel: "none", dockUsable: false })).disabled).toEqual(["toggle_panel", "toggle_terminal"]);
  });

  it("greys Notes while notes are off and Mark All Read with nothing unread", () => {
    expect(menuStateOf(facts({ notesEnabled: false, unread: 0 })).disabled).toEqual(["open_notes", "mark_all_read"]);
  });

  it("greys each fleet switch whose count is zero", () => {
    expect(menuStateOf(facts({ counts: NONE })).disabled).toEqual([
      "pause_all_threads",
      "resume_all_threads",
      "stop_all_threads",
      "archive_done_threads",
    ]);
    expect(menuStateOf(facts({ counts: { ...NONE, resume: 2 } })).disabled).not.toContain("resume_all_threads");
  });
});

describe("publishMenuState", () => {
  const meta = (over: Partial<SessionMeta>): SessionMeta =>
    ({ id: "s", environmentId: "local", parentId: null, cwd: "/tmp/a", title: "t", status: "running", archived: false, updatedAt: 1, ...over }) as SessionMeta;
  let metas: SessionMeta[] = [];
  let metaListener: () => void = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    rightPanel.reset();
    metas = [meta({ id: "a" })];
    vi.spyOn(sessionStore, "metas").mockImplementation(() => metas);
    vi.spyOn(sessionStore, "onMetaChange").mockImplementation((l) => {
      metaListener = l;
      return () => {};
    });
    vi.spyOn(workspaceStore, "getSnapshot").mockReturnValue({ workspaces: [], projects: [] } as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends the first state at once and each change once", () => {
    const send = vi.fn();
    const publisher = publishMenuState(() => ({ dockOpen: false, dockUsable: true }), send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].disabled).toContain("toggle_panel");
    expect(send.mock.calls[0][0].disabled).not.toContain("pause_all_threads");

    // A meta that moved without changing any fact sends nothing.
    metas = [meta({ id: "a", updatedAt: 2 })];
    metaListener();
    metaListener();
    vi.advanceTimersByTime(MENU_STATE_THROTTLE_MS);
    expect(send).toHaveBeenCalledTimes(1);

    // The thread settles: nothing left to pause or stop.
    metas = [meta({ id: "a", status: "idle", updatedAt: 3 })];
    metaListener();
    vi.advanceTimersByTime(MENU_STATE_THROTTLE_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].disabled).toEqual(expect.arrayContaining(["pause_all_threads", "stop_all_threads"]));

    // A root thread comes on screen with its panel open.
    rightPanel.open("a");
    rightPanel.visible("a", true);
    vi.advanceTimersByTime(MENU_STATE_THROTTLE_MS);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2][0].open).toContain("toggle_panel");
    expect(send.mock.calls[2][0].disabled).not.toContain("toggle_panel");

    shellStore.setState({ projectRailOpen: !shellStore.getState().projectRailOpen });
    vi.advanceTimersByTime(MENU_STATE_THROTTLE_MS);
    expect(send).toHaveBeenCalledTimes(4);
    publisher.stop();
  });

  it("greys Show Panel for a subagent on screen: its view has no panel", () => {
    metas = [meta({ id: "a" }), meta({ id: "child", parentId: "a" })];
    vi.spyOn(sessionStore, "metaOf").mockImplementation((id) => metas.find((m) => m.id === id) ?? null);
    rightPanel.visible("child", true);
    const send = vi.fn();
    publishMenuState(() => ({ dockOpen: false, dockUsable: true }), send).stop();
    expect(send.mock.calls[0][0].disabled).toContain("toggle_panel");
  });

  it("reads the facts again as the clock moves, for Archive Done's age rule", () => {
    const send = vi.fn();
    const publisher = publishMenuState(() => ({ dockOpen: false, dockUsable: true }), send);
    metas = [meta({ id: "a", status: "idle" })];
    vi.advanceTimersByTime(MENU_STATE_CLOCK_MS + MENU_STATE_THROTTLE_MS);
    expect(send).toHaveBeenCalledTimes(2);
    publisher.stop();
  });
});
