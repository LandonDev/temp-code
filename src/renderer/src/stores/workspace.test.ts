import { beforeEach, describe, expect, it } from "vitest";
import { leaf, newFileTab, newTab, newTerminalFile, type WorkspaceTab } from "../lib/layout";
import { newSession, type Session } from "../lib/session";
import { canTabVisitBack, canTabVisitForward } from "../lib/tabVisitHistory";
import {
  collectWorkspaceSnapshot,
  hydrateWorkspaceSnapshot,
  parseWorkspaceSnapshot,
} from "../lib/workspaceSnapshot";
import {
  mountActiveTab,
  trimMountedTabs,
  initialWorkspaceTabsState,
  setActiveTabId,
  setTabs,
  settleVisits,
  stepVisits,
  workspace,
  workspaceTabsStore,
  type WorkspaceTabsState,
} from "./workspace";

function tab(id: string): WorkspaceTab {
  return { ...newTab(`s-${id}`), id };
}

function state(ids: string[], activeTabId = ids[0]): WorkspaceTabsState {
  return initialWorkspaceTabsState(ids.map(tab), activeTabId);
}

/** Activate `id` the way App does: set it, then settle the trail. */
function visit(s: WorkspaceTabsState, id: string): WorkspaceTabsState {
  return settleVisits(setActiveTabId(s, id));
}

describe("workspace tab reducers", () => {
  it("keep the state object when nothing changes", () => {
    const s = settleVisits(state(["a", "b"]));
    expect(setTabs(s, s.tabs)).toBe(s);
    expect(setTabs(s, (tabs) => tabs)).toBe(s);
    expect(setActiveTabId(s, "a")).toBe(s);
    expect(setActiveTabId(s, (id) => id)).toBe(s);
    expect(settleVisits(s)).toBe(s);
    expect(stepVisits(s, "back").state).toBe(s);
    expect(stepVisits(s, "forward").state).toBe(s);
  });

  it("take a value or an updater", () => {
    const s = state(["a", "b"]);
    const dropped = setTabs(s, (tabs) => tabs.filter((t) => t.id !== "b"));
    expect(dropped.tabs.map((t) => t.id)).toEqual(["a"]);
    expect(setTabs(s, [tab("c")]).tabs[0]?.id).toBe("c");
    expect(setActiveTabId(s, "b").activeTabId).toBe("b");
    expect(setActiveTabId(s, () => "b").activeTabId).toBe("b");
  });

  it("mount the active tab at once and trim parked tabs down to the warm set", () => {
    let s = state(["a", "b", "c", "d", "e"]);
    expect(s.mountedTabIds).toEqual(["a"]);
    expect(mountActiveTab(s)).toBe(s);
    for (const id of ["b", "c", "d", "e"]) s = mountActiveTab(visit(s, id));
    expect(s.mountedTabIds).toEqual(["a", "b", "c", "d", "e"]);
    const trimmed = trimMountedTabs(s);
    expect(trimmed.mountedTabIds).toEqual(["c", "d", "e"]);
    expect(trimMountedTabs(trimmed)).toBe(trimmed);
    // A closed tab leaves the mounted set with the next activation.
    const closed = setTabs(trimmed, (tabs) => tabs.filter((t) => t.id !== "d"));
    expect(mountActiveTab(closed).mountedTabIds).toEqual(["c", "e"]);
  });

  it("default the active tab to the first one", () => {
    expect(initialWorkspaceTabsState([tab("x"), tab("y")]).activeTabId).toBe("x");
    expect(initialWorkspaceTabsState([]).activeTabId).toBe("");
  });
});

describe("visit trail", () => {
  it("records activations and steps back and forward through them", () => {
    let s = visit(visit(state(["a", "b", "c"]), "b"), "c");
    expect(s.visits.back).toEqual(["a", "b"]);
    expect(canTabVisitBack(s.visits)).toBe(true);
    expect(canTabVisitForward(s.visits)).toBe(false);

    const back = stepVisits(s, "back");
    expect(back.tabId).toBe("b");
    expect(back.state.visitFromHistory).toBe(true);
    s = visit(back.state, "b");
    expect(s.visitFromHistory).toBe(false);
    expect(s.visits.back).toEqual(["a"]);
    expect(s.visits.forward).toEqual(["c"]);

    const forward = stepVisits(s, "forward");
    expect(forward.tabId).toBe("c");
    s = visit(forward.state, "c");
    expect(s.visits.back).toEqual(["a", "b"]);
    expect(canTabVisitForward(s.visits)).toBe(false);
  });

  it("does not record a step taken from the trail as a new visit", () => {
    const s = visit(visit(state(["a", "b"]), "b"), "a");
    const back = stepVisits(s, "back");
    const settled = visit(back.state, "b");
    expect(settled.visits.forward).toEqual(["a"]);
    expect(settled.visits.back).toEqual(["a"]);
  });

  it("clears the from-trail flag even when the trail itself stands", () => {
    const s = { ...settleVisits(state(["a", "b"])), visitFromHistory: true };
    const settled = settleVisits(s);
    expect(settled).not.toBe(s);
    expect(settled.visitFromHistory).toBe(false);
    expect(settled.visits).toBe(s.visits);
  });

  it("drops closed tabs from the trail and refuses to step onto one", () => {
    let s = visit(visit(state(["a", "b", "c"]), "b"), "c");
    s = setTabs(s, (tabs) => tabs.filter((t) => t.id !== "b"));
    const back = stepVisits(s, "back");
    expect(back.tabId).toBe("a");
    s = settleVisits(s);
    expect(s.visits.back).toEqual(["a"]);
  });

  it("returns null when there is nowhere to go", () => {
    const s = settleVisits(state(["a"]));
    expect(stepVisits(s, "back").tabId).toBeNull();
    expect(stepVisits(s, "forward").tabId).toBeNull();
  });
});

describe("workspace actions", () => {
  beforeEach(() => {
    workspaceTabsStore.setState(state(["a", "b", "c"]), true);
  });

  it("route through the reducers and hand back the tab to activate", () => {
    workspace.setActiveTabId("b");
    workspace.settleVisits();
    workspace.setActiveTabId(() => "c");
    workspace.settleVisits();
    expect(workspace.visitBack()).toBe("b");
    expect(workspaceTabsStore.getState().visitFromHistory).toBe(true);
    workspace.setActiveTabId("b");
    workspace.settleVisits();
    expect(workspace.visitForward()).toBe("c");
    workspace.setActiveTabId("c");
    workspace.settleVisits();
    expect(workspace.visitForward()).toBeNull();
    expect(workspaceTabsStore.getState().visits.back).toEqual(["a", "b"]);
  });

  it("notify no subscriber for a no-op", () => {
    let fired = 0;
    const off = workspaceTabsStore.subscribe(() => fired++);
    const before = workspaceTabsStore.getState();
    workspace.setTabs(before.tabs);
    workspace.setActiveTabId("a");
    workspace.settleVisits();
    expect(workspace.visitBack()).toBeNull();
    expect(fired).toBe(0);
    workspace.mountActiveTab();
    workspace.trimMountedTabs();
    expect(fired).toBe(0);
    workspace.setActiveTabId("b");
    workspace.mountActiveTab();
    expect(fired).toBe(2);
    off();
  });
});

describe("workspace snapshot round-trip", () => {
  it("restores the store's tabs unchanged through save, parse and hydrate", () => {
    const session: Session = { ...newSession("cursor", "/repo"), id: "s1" };
    const file = newFileTab("/repo/README.md", "/repo");
    const term = newTerminalFile("/repo", "zsh");
    const rich: WorkspaceTab = {
      ...newTab("s1"),
      id: "t1",
      layout: {
        type: "split",
        id: "split1",
        dir: "right",
        children: [leaf("s1"), leaf("e1")],
        sizes: [0.3, 0.7],
      },
      focusedId: "e1",
      editorPanes: [{ id: "e1", files: [file], activeFileId: file.id }],
      terminalPanes: [{ id: "p1", files: [term], activeFileId: term.id }],
      diffOpen: true,
      diffFocused: true,
      groupId: "g1",
    };
    const plain = { ...newTab("s2"), id: "t2" };
    workspaceTabsStore.setState(initialWorkspaceTabsState([rich, plain], "t2"), true);

    const { tabs, activeTabId } = workspaceTabsStore.getState();
    const saved = collectWorkspaceSnapshot(tabs, [session], activeTabId, "/repo");
    const parsed = parseWorkspaceSnapshot(JSON.parse(JSON.stringify(saved)));
    expect(parsed).not.toBeNull();
    const restored = hydrateWorkspaceSnapshot(parsed!, new Map([["s1", session]]));
    expect(restored?.tabs).toEqual(tabs);
    expect(restored?.activeTabId).toBe("t2");
  });
});
