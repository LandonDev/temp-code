// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../lib/session";

const { state, openSettings } = vi.hoisted(() => ({
  state: { session: undefined as Session | undefined, listed: true },
  openSettings: vi.fn(),
}));
vi.mock("../lib/tcserver/store", () => ({
  useSession: () => state.session,
  sessionStore: { hasListed: () => state.listed, ensureLoaded: () => Promise.resolve() },
}));
vi.mock("./SessionPane", () => ({ SessionPane: () => <div data-testid="session-pane" /> }));
vi.mock("./FilePane", () => ({ FilePane: () => null }));
vi.mock("../lib/threadResources", () => ({ hostName: (id: string) => (id === "env_box" ? "box" : "this Mac") }));
vi.mock("../stores/shell", () => ({ shell: { openSettings } }));

import { PaneTree, SessionLeaf } from "./PaneTree";
import type { LayoutNode, WorkspaceTab } from "../lib/layout";
import { setExternalPaneDrop } from "../lib/paneDrop";
import { setTabSplitRatio } from "../lib/workspaceFocus";
import { initialWorkspaceTabsState, workspace, workspaceTabsStore } from "../stores/workspace";

afterEach(() => {
  cleanup();
  openSettings.mockClear();
  state.session = undefined;
  state.listed = true;
});

const base = { visible: true, focused: true, inSplit: false, composerFocused: false, recents: [], onFocus: () => {}, onOpenFile: () => {}, onOpenDiff: () => {} };

function thread(phase: "loading" | "gone"): Session {
  return {
    id: "t1",
    environmentId: "env_box",
    harness: "claude",
    model: "claude:sonnet-5.5",
    modelSettings: {},
    runtimeMode: "supervised",
    title: "",
    cwd: "/repo",
    blocks: [],
    load: { phase, since: 0, attempt: 0 },
  } as Session;
}

describe("SessionLeaf for a thread no host has", () => {
  it("a gone thread says which host it left, and closes its tab or opens the archive", () => {
    state.session = thread("gone");
    const onClose = vi.fn();
    render(<SessionLeaf id="t1" {...base} onClose={onClose} />);
    expect(screen.getByText("No longer on box")).toBeTruthy();
    expect(screen.queryByTestId("session-pane")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    expect(onClose).toHaveBeenCalledWith("t1");
    fireEvent.click(screen.getByRole("button", { name: "Open archived" }));
    expect(openSettings).toHaveBeenCalledWith("archive");
  });

  it("in a split, a gone thread closes its pane", () => {
    state.session = thread("gone");
    const onClose = vi.fn();
    render(<SessionLeaf id="t1" {...base} inSplit onClose={onClose} />);
    expect(screen.queryByRole("button", { name: "Close tab" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close pane" }));
    expect(onClose).toHaveBeenCalledWith("t1");
  });

  it("a thread the store dropped after the hosts listed draws the line, not nothing", () => {
    render(<SessionLeaf id="t1" {...base} onClose={() => {}} />);
    expect(screen.getByText("No longer on any host")).toBeTruthy();
  });

  it("before any host has listed, a missing thread may still be on its way: nothing yet", () => {
    state.listed = false;
    const { container } = render(<SessionLeaf id="t1" {...base} onClose={() => {}} />);
    expect(container.textContent).toBe("");
  });

  it("a provisional thread still loading is an ordinary pane", () => {
    state.session = thread("loading");
    render(<SessionLeaf id="t1" {...base} onClose={() => {}} />);
    expect(screen.getByTestId("session-pane")).toBeTruthy();
  });
});

function splitTab(sizes: number[]): WorkspaceTab {
  const layout: LayoutNode = {
    type: "split",
    id: "row",
    dir: "right",
    children: sizes.map((_, i) => ({ type: "leaf", id: `p${i}` })),
    sizes,
  };
  return { kind: "session", id: "tab", layout, focusedId: "p0", editorPanes: [], terminalPanes: [] } as WorkspaceTab;
}

const noop = () => {};
function tree() {
  const onRatio = (tabId: string, splitId: string, index: number, ratio: number) =>
    workspace.setTabs((tabs) => setTabSplitRatio(tabs, tabId, splitId, index, ratio));
  return render(
    <PaneTree
      tabId="tab"
      visible
      onFocus={noop}
      onClose={noop}
      onSelectFile={noop}
      onCloseFile={noop}
      onReorderFiles={noop}
      onFileDirtyChange={noop}
      onFileErrorCountChange={noop}
      onRatio={onRatio}
      onOpenFile={noop}
      onOpenDiff={noop}
      onMovePane={noop}
    />,
  );
}

describe("PaneTree's sashes", () => {
  it("a double-click on a sash makes a three-pane row equal", () => {
    state.session = thread("loading");
    workspaceTabsStore.setState(initialWorkspaceTabsState([splitTab([0.6, 0.2, 0.2])]));
    tree();
    fireEvent.doubleClick(screen.getAllByRole("separator", { name: "Resize panes" })[1]);
    const layout = workspaceTabsStore.getState().tabs[0].layout as Extract<LayoutNode, { type: "split" }>;
    for (const size of layout.sizes) expect(size).toBeCloseTo(1 / 3);
  });
});

describe("PaneTree under a dragged chip", () => {
  it("shows where the thread lands on the pane under the pointer only, and dims the thread's own pane", () => {
    state.session = thread("loading");
    workspaceTabsStore.setState(initialWorkspaceTabsState([splitTab([0.5, 0.5])]));
    const { container } = tree();
    act(() => setExternalPaneDrop({ fromId: "p0", overId: "p1", edge: "right" }));
    const pane = (id: string) => container.querySelector<HTMLElement>(`[data-pane-id="${id}"]`)!;
    expect(pane("p1").querySelector("[data-pane-drop-hint]")?.getAttribute("data-edge")).toBe("right");
    expect(pane("p0").querySelector("[data-pane-drop-hint]")).toBeNull();
    expect(pane("p0").className).toMatch(/\bopacity-40\b/);
    expect(pane("p1").className).not.toMatch(/\bopacity-40\b/);
    act(() => setExternalPaneDrop(null));
    expect(container.querySelector("[data-pane-drop-hint]")).toBeNull();
  });
});
