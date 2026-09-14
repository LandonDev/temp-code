import { describe, expect, it } from "vitest";
import {
  leaf,
  leafIds,
  newFileTab,
  newTab,
  newTerminalFile,
  type LayoutNode,
  type WorkspaceTab,
} from "../lib/layout";
import { newSession, type Session } from "../lib/session";
import {
  initialWorkspaceTabsState,
  settleVisits,
  setActiveTabId,
  type WorkspaceTabsState,
} from "./workspace";
import {
  activateTab,
  appendTab,
  closeTab,
  focusPane,
  focusSession,
  isolateTerminals,
  leaveGroupIfMoved,
  openInBackground,
  openSessionIds,
  projectTabTarget,
  replacePane,
  splitBeside,
} from "./workspaceActions";

function tab(id: string, over: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return { ...newTab(`s-${id}`), id, ...over };
}

function state(tabs: WorkspaceTab[], activeTabId = tabs[0]?.id ?? ""): WorkspaceTabsState {
  return settleVisits(initialWorkspaceTabsState(tabs, activeTabId));
}

function session(id: string, projectId: string | null = null): Session {
  return { ...newSession("claude", "/repo"), id, projectId };
}

function row(...ids: string[]): LayoutNode {
  return {
    type: "split",
    id: "sp",
    dir: "row",
    children: ids.map(leaf),
    sizes: ids.map(() => 1 / ids.length),
  };
}

const noProject = () => undefined;

describe("workspace actions keep the state object on a no-op", () => {
  const s = state([tab("a"), tab("b")]);

  it("activateTab on the active tab", () => {
    expect(activateTab(s, "a")).toBe(s);
  });

  it("focusPane on the focused pane, or without an active tab", () => {
    expect(focusPane(s, "s-a")).toBe(s);
    const orphan = { ...s, activeTabId: "zzz" };
    expect(focusPane(orphan, "s-a")).toBe(orphan);
  });

  it("closeTab of an unknown tab", () => {
    expect(closeTab(s, "zzz")).toBe(s);
  });

  it("focusSession of a session with no pane", () => {
    expect(focusSession(s, "s-zzz")).toEqual({ state: s, tabId: null });
  });

  it("focusSession of the pane already on screen", () => {
    expect(focusSession(s, "s-a").state).toBe(s);
  });

  it("splitBeside when no pane holds the source", () => {
    expect(splitBeside(s, "s-zzz", "s-new")).toBe(s);
  });

  it("openInBackground of a session that already has a pane", () => {
    expect(openInBackground(s, session("s-b"), undefined, noProject)).toBe(s);
  });

  it("replacePane on a pane the tab does not hold", () => {
    expect(replacePane(s, "a", "s-b", "s-new")).toBe(s);
    expect(replacePane(s, "zzz", "s-a", "s-new")).toBe(s);
  });

  it("leaveGroupIfMoved: ungrouped tab, matching project, no project, background pane", () => {
    expect(leaveGroupIfMoved(s, "s-a", "repo", noProject)).toBe(s);
    const grouped = state([
      tab("a", { groupId: "g" }),
      tab("b", { groupId: "g", layout: leaf("s-b"), focusedId: "s-b" }),
    ]);
    const projectOf = (id: string) => (id === "b" ? "repo" : undefined);
    expect(leaveGroupIfMoved(grouped, "s-a", "repo", projectOf)).toBe(grouped);
    expect(leaveGroupIfMoved(grouped, "s-a", undefined, projectOf)).toBe(grouped);
    // A background pane moving project does not change what the group check sees.
    const background = state([
      tab("a", { groupId: "g", layout: row("s-a", "s-bg"), focusedId: "s-a" }),
      tab("b", { groupId: "g" }),
    ]);
    expect(leaveGroupIfMoved(background, "s-bg", "other", projectOf)).toBe(background);
  });

  it("isolateTerminals when no file pane holds a terminal", () => {
    expect(isolateTerminals(s)).toBe(s);
    const terminal = newTerminalFile("/repo", "zsh");
    const withTerminal = state([
      tab("a", { terminalPanes: [{ id: "t", files: [terminal], activeFileId: terminal.id }] }),
    ]);
    expect(isolateTerminals(withTerminal)).toBe(withTerminal);
  });
});

describe("workspace actions", () => {
  it("activateTab switches the active tab", () => {
    const s = state([tab("a"), tab("b")]);
    expect(activateTab(s, "b").activeTabId).toBe("b");
  });

  it("focusPane focuses a pane of the active tab and drops the diff focus", () => {
    const s = state([tab("a", { layout: row("s-a", "s-a2"), diffFocused: true })]);
    const next = focusPane(s, "s-a2");
    expect(next.tabs[0].focusedId).toBe("s-a2");
    expect(next.tabs[0].diffFocused).toBe(false);
  });

  it("appendTab lands beside the active tab and inherits its group when projects match", () => {
    const s = state([tab("a", { groupId: "g" }), tab("b")], "a");
    const incoming = tab("c");
    const projectOf = (id: string) => (id === "c" || id === "a" ? "repo" : undefined);
    const next = appendTab(s, incoming, projectOf);
    expect(next.tabs.map((t) => t.id)).toEqual(["a", "c", "b"]);
    expect(next.tabs[1].groupId).toBe("g");
    const other = appendTab(s, tab("d"), (id) => (id === "d" ? "elsewhere" : "repo"));
    expect(other.tabs[1].groupId).toBeUndefined();
  });

  it("closeTab drops the tab and leaves the active id to the caller", () => {
    const s = state([tab("a"), tab("b")], "a");
    const next = closeTab(s, "a");
    expect(next.tabs.map((t) => t.id)).toEqual(["b"]);
    expect(next.activeTabId).toBe("a");
  });

  it("focusSession brings the holding tab forward with that pane focused", () => {
    const s = state([tab("a"), tab("b", { layout: row("s-b", "s-b2") })], "a");
    const { state: next, tabId } = focusSession(s, "s-b2");
    expect(tabId).toBe("b");
    expect(next.activeTabId).toBe("b");
    expect(next.tabs[1].focusedId).toBe("s-b2");
    expect(next.tabs[0]).toBe(s.tabs[0]);
  });

  it("splitBeside splits the source to the right, focused, and brings its tab forward", () => {
    const s = state([tab("a"), tab("b", { diffFocused: true })], "a");
    const next = splitBeside(s, "s-b", "s-new");
    expect(next.activeTabId).toBe("b");
    expect(leafIds(next.tabs[1].layout)).toEqual(["s-b", "s-new"]);
    expect(next.tabs[1].focusedId).toBe("s-new");
    expect(next.tabs[1].diffFocused).toBe(false);
    expect(next.tabs[0]).toBe(s.tabs[0]);
  });

  it("openInBackground adds a tab beside the active one without moving focus", () => {
    const s = state([tab("a"), tab("b")], "a");
    const incoming = session("s-new");
    const next = openInBackground(s, incoming, "repo", noProject);
    expect(next.activeTabId).toBe("a");
    expect(next.tabs.map((t) => leafIds(t.layout)[0])).toEqual(["s-a", "s-new", "s-b"]);
    expect(next.tabs[0].focusedId).toBe("s-a");
  });

  it("openInBackground splits a child beside its open parent", () => {
    const s = state([tab("a")]);
    const child = { ...session("s-child"), parentId: "s-a" };
    const next = openInBackground(s, child, "repo", noProject);
    expect(next.tabs).toHaveLength(1);
    expect(leafIds(next.tabs[0].layout)).toEqual(["s-a", "s-child"]);
    expect(next.tabs[0].focusedId).toBe("s-a");
  });

  it("openInBackground labels the new tab with its project for the group check", () => {
    const s = state([tab("a", { groupId: "g" })]);
    const seen: string[] = [];
    const projectOf = (id: string) => {
      seen.push(id);
      return "repo";
    };
    const next = openInBackground(s, session("s-new"), "repo", projectOf);
    expect(next.tabs[1].groupId).toBe("g");
    expect(seen).not.toContain(next.tabs[1].id);
    const apart = openInBackground(s, session("s-far"), "elsewhere", projectOf);
    expect(apart.tabs[1].groupId).toBeUndefined();
  });

  it("replacePane swaps the pane's session, focuses it and brings the tab forward", () => {
    const s = state([tab("a"), tab("b")], "a");
    const next = replacePane(s, "b", "s-b", "s-new");
    expect(next.activeTabId).toBe("b");
    expect(leafIds(next.tabs[1].layout)).toEqual(["s-new"]);
    expect(next.tabs[1].focusedId).toBe("s-new");
  });

  it("leaveGroupIfMoved drops the tab from a group whose other tabs are on another project", () => {
    const s = state([tab("a", { groupId: "g" }), tab("b", { groupId: "g" })]);
    const projectOf = (id: string) => (id === "b" ? "repo" : undefined);
    const next = leaveGroupIfMoved(s, "s-a", "worktree", projectOf);
    expect(next.tabs[0].groupId).toBeUndefined();
    expect(next.tabs[1].groupId).toBe("g");
  });

  it("isolateTerminals moves terminal tabs out of file panes", () => {
    const fileTab = newFileTab("/repo/a.ts");
    const terminal = newTerminalFile("/repo", "zsh");
    const s = state([
      tab("a", { editorPanes: [{ id: "e", files: [fileTab, terminal], activeFileId: fileTab.id }] }),
    ]);
    const next = isolateTerminals(s);
    expect(next.tabs[0].editorPanes[0].files).toEqual([fileTab]);
    expect(next.tabs[0].terminalPanes.flatMap((pane) => pane.files)).toEqual([terminal]);
  });

  it("openSessionIds lists every pane's session", () => {
    const s = state([tab("a"), tab("b", { layout: row("s-b", "s-b2") })]);
    expect([...openSessionIds(s.tabs)].sort()).toEqual(["s-a", "s-b", "s-b2"]);
  });
});

describe("projectTabTarget", () => {
  const sessions = [session("s-a", "p1"), session("s-b", "p2"), session("s-c", "p1")];

  it("stays when the active tab already shows the project", () => {
    const s = state([tab("a"), tab("b")], "a");
    expect(projectTabTarget(s, sessions, "p1")).toEqual({ action: "stay" });
  });

  it("activates the most recently visited tab of the project", () => {
    let s = state([tab("a"), tab("b"), tab("c")], "a");
    s = settleVisits(setActiveTabId(s, "c"));
    s = settleVisits(setActiveTabId(s, "b"));
    expect(projectTabTarget(s, sessions, "p1")).toEqual({ action: "activate", tabId: "c" });
  });

  it("falls back to the first tab of the project, then to opening a thread", () => {
    const s = state([tab("b"), tab("a"), tab("c")], "b");
    expect(projectTabTarget(s, sessions, "p1")).toEqual({ action: "activate", tabId: "a" });
    expect(projectTabTarget(s, sessions, "p9")).toEqual({ action: "open" });
  });
});
