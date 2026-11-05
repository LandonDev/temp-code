// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "../lib/tcserver/types";

const state = vi.hoisted(() => ({
  workspaces: [] as { id: string; environmentId: string; path: string; git: boolean }[],
  agents: [] as SessionMeta[],
  meta: null as SessionMeta | null,
}));

vi.mock("../lib/threads/agents", () => ({
  useAgents: () => state.agents,
}));
vi.mock("../lib/tcserver/workspaces", () => ({
  useProjects: () => [{ id: "p1", environmentId: "local", cwd: "/p", name: "P" }],
  useWorkspaces: () => state.workspaces,
}));
vi.mock("../lib/tcserver/projects", () => ({ projectForCwd: (cwd: string) => (cwd === "/p" ? { id: "p1", environmentId: "local", cwd: "/p", name: "P" } : undefined) }));
// The joined activity rows: one per background task on the meta is enough for the frame.
vi.mock("../lib/activity", () => ({
  useActivity: () => ({ rows: (state.meta?.background?.tasks ?? []).map((task) => ({ id: task.id, kind: task.kind, label: task.label })), meta: state.meta }),
}));
vi.mock("../hooks/useGitFileStatuses", () => ({ useGitFileStatuses: () => ({}) }));
vi.mock("./threads/fleet/FleetPanel", () => ({
  FleetList: (p: { sessionId: string; emptyLine?: string }) => (
    <div data-testid="agents-body" data-thread={p.sessionId} data-empty-line={p.emptyLine}>
      agents
    </div>
  ),
}));
vi.mock("./threads/ActivitySection", () => ({ ActivitySection: (p: { threadId: string }) => <div data-testid="activity-body" data-thread={p.threadId}>activity</div> }));
vi.mock("./threads/NotesPanel", () => ({ NotesBody: () => <div data-testid="notes-body">notes</div> }));
vi.mock("../chrome/rail/ChangesPanel", () => ({ ChangesPanel: () => <div data-testid="changes-body">changes</div> }));
vi.mock("../chrome/rail/BuildPanel", () => ({ BuildPanel: () => <div>build</div> }));
vi.mock("../chrome/rail/DebugPanel", () => ({ default: () => <div>debug</div> }));
vi.mock("../chrome/FileTree", () => ({
  FileTree: (p: { onFileMoved?: (from: string, to: string) => void }) => (
    <button type="button" data-testid="files-body" onClick={() => p.onFileMoved?.("/p/a.ts", "/p/b.ts")}>
      files
    </button>
  ),
}));

import { rightPanel, useShownSection } from "../lib/rightPanel";
import type { Session } from "../lib/session";
import { MASTER_AGENTS_EMPTY, RightPanel } from "./RightPanel";
import { SessionActionsContext, type SessionActions } from "./threadChat";

const session = { id: "s1", environmentId: "local", title: "T", cwd: "/p", projectId: "p1", status: "idle", blocks: [] } as unknown as Session;
const agent = (id: string, status: string) => ({ id, status, parentId: "s1" }) as unknown as SessionMeta;
const noop = () => {};

beforeEach(() => {
  rightPanel.reset();
  state.agents = [];
  state.workspaces = [];
  state.meta = null;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RightPanel", () => {
  it("resizes from a focusable left-edge sash, saves the width and resets on double-click", () => {
    rightPanel.open("s1");
    const { container } = render(<RightPanel session={session} onOpenFile={noop} onOpenDiff={noop} />);
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ width: 1000 } as DOMRect);
    const handle = screen.getByRole("separator", { name: "Resize panel" });
    const pane = handle.parentElement!;
    handle.focus();
    expect(document.activeElement).toBe(handle);
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.className).toContain("focus-visible:bg-accent");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle.getAttribute("aria-valuenow")).toBe("340");
    expect(pane.style.width).toBe("340px");
    expect(rightPanel.get("s1").width).toBe(340);
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(pane.style.width).toBe("440px");
    expect(rightPanel.get("s1").width).toBe(440);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(pane.style.width).toBe("420px");
    fireEvent.doubleClick(handle);
    expect(handle.getAttribute("aria-valuenow")).toBe("320");
    expect(pane.style.width).toBe("320px");
    expect(rightPanel.get("s1").width).toBe(320);
  });

  it("a fitted panel's keys step from the width on screen, not a stale drag width", () => {
    rightPanel.open("s1");
    rightPanel.setWidth("s1", 400);
    // Mounted narrow: fitted to 280 (the drag clamps to the row's room).
    const { container, rerender } = render(<RightPanel session={session} width={280} maxWidth={280} onOpenFile={noop} onOpenDiff={noop} />);
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ width: 1000 } as DOMRect);
    // The row widened: the panel draws its stored 400 again.
    rerender(<RightPanel session={session} width={400} maxWidth={640} onOpenFile={noop} onOpenDiff={noop} />);
    const handle = screen.getByRole("separator", { name: "Resize panel" });
    expect(handle.getAttribute("aria-valuenow")).toBe("400");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(rightPanel.get("s1").width).toBe(420);
  });

  it("renders nothing while closed, and nothing for a subagent", () => {
    const { container } = render(<RightPanel session={session} onOpenFile={noop} onOpenDiff={noop} />);
    expect(container.querySelector("aside")).toBeNull();
    rightPanel.open("s2");
    const sub = { ...session, id: "s2", parentId: "s1" } as unknown as Session;
    const r = render(<RightPanel session={sub} onOpenFile={noop} onOpenDiff={noop} />);
    expect(r.container.querySelector("aside")).toBeNull();
  });

  it("a thread watching its subagents opens on Agents, with no Activity section of its own", () => {
    state.agents = [agent("a1", "running"), agent("a2", "done")];
    state.meta = { id: "s1", status: "watching", background: { tasks: [], agents: ["a1"], batch: null, watchingSince: 1 } } as unknown as SessionMeta;
    rightPanel.open("s1");
    render(<RightPanel session={session} onOpenFile={noop} onOpenDiff={noop} />);
    const tabs = screen.getAllByRole("tab").map((t) => t.getAttribute("aria-label"));
    expect(tabs).toEqual(["Agents", "Changes", "Notes", "Files", "Build", "Debug"]); // a dev build (vitest) lists Debug
    expect(screen.getByTestId("agents-body")).toBeTruthy();
    // A pick is remembered for the thread.
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    expect(screen.getByTestId("notes-body")).toBeTruthy();
    expect(rightPanel.get("s1").section).toBe("notes");
  });

  it("reports the section it draws, default or by name, and none once it closes or leaves the screen", () => {
    state.agents = [agent("a1", "running")];
    rightPanel.open("s1");
    const { unmount, rerender } = render(<RightPanel session={session} onOpenFile={noop} onOpenDiff={noop} />);
    let shown: string | null = null;
    const read = () => {
      const probe = render(<Probe />);
      probe.unmount();
      return shown;
    };
    function Probe() {
      shown = useShownSection("s1");
      return null;
    }
    expect(rightPanel.get("s1").section).toBeNull();
    expect(read()).toBe("agents");
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    expect(read()).toBe("notes");
    rerender(<RightPanel session={session} motion="leave" onOpenFile={noop} onOpenDiff={noop} />);
    expect(read()).toBeNull();
    rerender(<RightPanel session={session} onOpenFile={noop} onOpenDiff={noop} />);
    expect(read()).toBe("notes");
    unmount();
    expect(read()).toBeNull();
  });

  it("subagents beside a background task still open on Agents; Activity sits second", () => {
    state.agents = [agent("a1", "running")];
    state.meta = { id: "s1", status: "running", background: { tasks: [{ id: "t1", label: "x", kind: "shell", startedAt: 0 }], agents: ["a1"], batch: null, watchingSince: null } } as unknown as SessionMeta;
    rightPanel.open("s1");
    render(<RightPanel session={session} onOpenFile={noop} onOpenDiff={noop} />);
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("aria-label")).slice(0, 2)).toEqual(["Agents", "Activity"]);
    expect(screen.getByTestId("agents-body")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.getByTestId("activity-body")).toBeTruthy();
  });

  it("the header is a 40px row of flat 28px icon buttons on the 12px inset, the selected one's fill gliding, no track", () => {
    rightPanel.open("s1");
    render(<RightPanel session={session} onOpenFile={noop} onOpenDiff={noop} />);
    const list = screen.getByRole("tablist", { name: "Panel sections" });
    expect(list.className).not.toMatch(/overflow/);
    expect(list.className.split(/\s+/)).toEqual(expect.arrayContaining(["bg-transparent", "p-0", "gap-0.5"]));
    const pill = list.querySelector<HTMLElement>("[data-slot=tabs-indicator]")!;
    expect(pill.className).toContain("bg-foreground/7");
    const header = list.closest(".border-b") as HTMLElement;
    expect(header.className.split(/\s+/)).toEqual(expect.arrayContaining(["h-10", "px-3"]));
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.getAttribute("aria-label")).toBeTruthy();
      expect(tab.textContent).toBe("");
      expect(tab.querySelector("svg")).toBeTruthy();
      expect(tab.className.split(/\s+/)).toEqual(expect.arrayContaining(["size-7", "rounded-lg"]));
    }
  });

  it("arrives from the right edge on transitions, and leaves over the thread, inert, until its fade ends", () => {
    rightPanel.open("s1");
    const onLeft = vi.fn();
    const { container, rerender } = render(<RightPanel session={session} motion="arrive" onLeft={onLeft} onOpenFile={noop} onOpenDiff={noop} />);
    const pane = container.querySelector("aside")!;
    const classes = () => pane.className.split(/\s+/);
    expect(classes()).toEqual(expect.arrayContaining(["transition-[translate,opacity]", "duration-(--dur-slow)", "ease-(--ease-out)", "starting:translate-x-full", "starting:opacity-0", "motion-reduce:transition-opacity"]));
    expect(classes().some((c) => /^transition-\[.*width/.test(c) || c === "transition-all")).toBe(false);
    expect(pane.hasAttribute("data-ending-style")).toBe(false);
    rightPanel.close("s1");
    rerender(<RightPanel session={session} motion="leave" onLeft={onLeft} onOpenFile={noop} onOpenDiff={noop} />);
    expect(container.querySelector("aside")).toBe(pane);
    expect(pane.hasAttribute("data-ending-style")).toBe(true);
    expect(pane.hasAttribute("inert")).toBe(true);
    expect(classes()).toEqual(expect.arrayContaining(["absolute", "right-0", "data-ending-style:translate-x-1/4", "data-ending-style:opacity-0", "data-ending-style:duration-(--dur-fast)", "data-ending-style:ease-(--ease-exit)"]));
    expect(classes()).not.toContain("relative");
    fireEvent.transitionEnd(pane, { propertyName: "translate" });
    expect(onLeft).not.toHaveBeenCalled();
    fireEvent.transitionEnd(pane, { propertyName: "opacity" });
    expect(onLeft).toHaveBeenCalledTimes(1);
  });

  it("a remembered section that no longer exists falls back to the default; the close button closes", () => {
    rightPanel.open("s1", "agents");
    render(<RightPanel session={session} onOpenFile={noop} onOpenDiff={noop} />);
    expect(screen.getByTestId("changes-body")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Agents" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hide panel" }));
    expect(rightPanel.get("s1").open).toBe(false);
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("the Debug section waits for its chunk on a skeleton of rows, never a bare spinner", async () => {
    rightPanel.open("s1", "debug");
    const { container } = render(<RightPanel session={session} onOpenFile={noop} onOpenDiff={noop} />);
    expect(container.querySelector('[data-surface-skeleton="rows"]')).toBeTruthy();
    expect(container.querySelector('[data-slot="spinner"]')).toBeNull();
    expect(await screen.findByText("debug")).toBeTruthy();
  });

  it("the file tree's moves reach App's handler, so open tabs follow a rename", () => {
    rightPanel.open("s1", "files");
    const onFileMoved = vi.fn();
    render(
      <SessionActionsContext.Provider value={{ onFileMoved } as unknown as SessionActions}>
        <RightPanel session={session} onOpenFile={noop} onOpenDiff={noop} />
      </SessionActionsContext.Provider>,
    );
    fireEvent.click(screen.getByTestId("files-body"));
    expect(onFileMoved).toHaveBeenCalledWith("/p/a.ts", "/p/b.ts");
  });

  it("a chat with no project has notes alone", () => {
    const chat = { ...session, cwd: "~", projectId: null } as unknown as Session;
    rightPanel.open("s1");
    const r = render(<RightPanel session={chat} onOpenFile={noop} onOpenDiff={noop} />);
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("aria-label"))).toEqual(["Notes"]);
    r.unmount();
  });

  it("a loose chat in a git workspace lists Changes and Files on the workspace's folder, never Build", () => {
    state.workspaces = [{ id: "w1", environmentId: "local", path: "/w", git: true }];
    const chat = { ...session, cwd: "/w", projectId: null, workspaceId: "w1" } as unknown as Session;
    rightPanel.open("s1");
    const r = render(<RightPanel session={chat} onOpenFile={noop} onOpenDiff={noop} />);
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("aria-label"))).toEqual(["Changes", "Notes", "Files"]);
    expect(screen.getByTestId("changes-body")).toBeTruthy();
    r.unmount();
  });

  it("a loose chat whose folder is a project's checkout lists Changes, Notes and Files, never Build", () => {
    const chat = { ...session, cwd: "/p", projectId: null } as unknown as Session;
    rightPanel.open("s1");
    const r = render(<RightPanel session={chat} onOpenFile={noop} onOpenDiff={noop} />);
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("aria-label"))).toEqual(["Changes", "Notes", "Files"]);
    r.unmount();
  });

  it("a project thread in a worktree still lists Build", () => {
    const inWorktree = { ...session, cwd: "/p/.claude/worktrees/x" } as unknown as Session;
    rightPanel.open("s1");
    const r = render(<RightPanel session={inWorktree} onOpenFile={noop} onOpenDiff={noop} />);
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("aria-label"))).toContain("Build");
    r.unmount();
  });

  it("a loose chat in a workspace that is no repository has notes alone", () => {
    state.workspaces = [{ id: "w1", environmentId: "local", path: "/w", git: false }];
    const chat = { ...session, cwd: "/w", projectId: null, workspaceId: "w1" } as unknown as Session;
    rightPanel.open("s1");
    const r = render(<RightPanel session={chat} onOpenFile={noop} onOpenDiff={noop} />);
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("aria-label"))).toEqual(["Notes"]);
    r.unmount();
  });

  it("a background task alone gives the thread its Activity section, its default", () => {
    state.meta = { id: "s1", status: "idle", background: { tasks: [{ id: "t1", label: "x", kind: "shell", startedAt: 0 }], agents: [], batch: null, watchingSince: null } } as unknown as SessionMeta;
    rightPanel.open("s1");
    render(<RightPanel session={session} onOpenFile={noop} onOpenDiff={noop} />);
    expect(screen.getAllByRole("tab")[0].getAttribute("aria-label")).toBe("Activity");
    expect(screen.getByTestId("activity-body")).toBeTruthy();
  });
});

describe("RightPanel on the thread a pane shows", () => {
  // A master's pane showing a batch child on the box: the sections read the child.
  const child = { ...session, id: "kid", environmentId: "env_box", cwd: "/srv/kid" } as unknown as Session;

  it("draws the shown thread's sections on the pane's open state and width, its section remembered for the shown thread", () => {
    state.agents = [{ id: "k1", status: "running", parentId: "kid" } as unknown as SessionMeta];
    rightPanel.open("master", "notes");
    rightPanel.setWidth("master", 360);
    rightPanel.showThread("master", { id: "kid", environmentId: "env_box" });
    const { container } = render(<RightPanel session={child} paneId="master" onOpenFile={noop} onOpenDiff={noop} />);
    expect((container.querySelector("aside") as HTMLElement).style.width).toBe("360px");
    expect(screen.getByTestId("agents-body").getAttribute("data-thread")).toBe("kid");
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    expect(rightPanel.get("kid").section).toBe("notes");
    fireEvent.click(screen.getByRole("tab", { name: "Agents" }));
    expect(rightPanel.get("kid").section).toBe("agents");
    // The master's own memory is untouched; Back shows it again.
    rightPanel.showThread("master", null);
    expect(rightPanel.get("master").section).toBe("notes");
  });

  it("reports what it draws on the pane, and closes the pane's panel", () => {
    state.agents = [{ id: "k1", status: "running", parentId: "kid" } as unknown as SessionMeta];
    rightPanel.open("master");
    rightPanel.showThread("master", { id: "kid", environmentId: "env_box" });
    let seen: string | null = null;
    function Probe() {
      seen = useShownSection("master");
      return null;
    }
    render(
      <>
        <RightPanel session={child} paneId="master" onOpenFile={noop} onOpenDiff={noop} />
        <Probe />
      </>,
    );
    expect(seen).toBe("agents");
    fireEvent.click(screen.getByRole("button", { name: "Hide panel" }));
    expect(rightPanel.get("master").open).toBe(false);
  });

  it("a subagent a pane shows gets its agents and activity, never notes", () => {
    state.agents = [{ id: "g1", status: "running", parentId: "sub" } as unknown as SessionMeta];
    rightPanel.open("master");
    const sub = { ...session, id: "sub", parentId: "kid", cwd: "~", projectId: undefined } as unknown as Session;
    rightPanel.showThread("master", { id: "sub", environmentId: "local" });
    render(<RightPanel session={sub} paneId="master" onOpenFile={noop} onOpenDiff={noop} />);
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("aria-label"))).toEqual(["Agents"]);
    expect(screen.getByTestId("agents-body").getAttribute("data-thread")).toBe("sub");
  });

  it("a master's own Agents section says its batch threads are on the board", () => {
    state.agents = [{ id: "a1", status: "done", parentId: "s1" } as unknown as SessionMeta];
    rightPanel.open("s1", "agents");
    const master = { ...session, isMaster: true } as unknown as Session;
    render(<RightPanel session={master} onOpenFile={noop} onOpenDiff={noop} />);
    expect(screen.getByTestId("agents-body").getAttribute("data-empty-line")).toBe(MASTER_AGENTS_EMPTY);
    cleanup();
    render(<RightPanel session={session} onOpenFile={noop} onOpenDiff={noop} />);
    expect(screen.getByTestId("agents-body").getAttribute("data-empty-line")).toBeNull();
  });
});
