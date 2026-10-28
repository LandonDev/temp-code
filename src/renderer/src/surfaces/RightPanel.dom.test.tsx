// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "../lib/tcserver/types";

const state = vi.hoisted(() => ({
  workspaces: [] as { id: string; environmentId: string; path: string; git: boolean }[],
  agents: [] as SessionMeta[],
  meta: null as SessionMeta | null,
  devRunning: false,
}));

vi.mock("../lib/threads/agents", () => ({
  useAgents: () => state.agents,
  useMetaById: () => state.meta,
  fleetCounts: (agents: SessionMeta[]) => ({
    working: agents.filter((a) => a.status === "running").length,
    waiting: agents.filter((a) => a.status === "waiting").length,
    failed: 0,
    done: 0,
  }),
}));
vi.mock("../lib/tcserver/workspaces", () => ({
  useProjects: () => [{ id: "p1", environmentId: "local", cwd: "/p", name: "P" }],
  useWorkspaces: () => state.workspaces,
}));
vi.mock("../lib/tcserver/projects", () => ({ projectForCwd: (cwd: string) => (cwd === "/p" ? { id: "p1", environmentId: "local", cwd: "/p", name: "P" } : undefined) }));
vi.mock("../lib/devServers", () => ({ useDevRunning: () => state.devRunning }));
// The joined activity rows: one per background task on the meta is enough for the frame.
vi.mock("../lib/activity", () => ({
  useActivity: () => ({ rows: (state.meta?.background?.tasks ?? []).map((task) => ({ id: task.id, kind: task.kind, label: task.label })), meta: state.meta }),
}));
vi.mock("../hooks/useGitFileStatuses", () => ({ useGitFileStatuses: () => ({}) }));
vi.mock("./threads/fleet/FleetPanel", () => ({ FleetList: () => <div data-testid="agents-body">agents</div> }));
vi.mock("./threads/ActivitySection", () => ({
  ActivitySection: ({ onOpenAgents }: { onOpenAgents: () => void }) => (
    <button type="button" data-testid="activity-body" onClick={onOpenAgents}>
      activity
    </button>
  ),
}));
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

import { rightPanel } from "../lib/rightPanel";
import type { Session } from "../lib/session";
import { RightPanel } from "./RightPanel";
import { SessionActionsContext, type SessionActions } from "./threadChat";

const session = { id: "s1", environmentId: "local", title: "T", cwd: "/p", projectId: "p1", status: "idle", blocks: [] } as unknown as Session;
const agent = (id: string, status: string) => ({ id, status, parentId: "s1" }) as unknown as SessionMeta;
const noop = () => {};

beforeEach(() => {
  rightPanel.reset();
  state.agents = [];
  state.workspaces = [];
  state.meta = null;
  state.devRunning = false;
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

  it("renders nothing while closed, and nothing for a subagent", () => {
    const { container } = render(<RightPanel session={session} onOpenFile={noop} onOpenDiff={noop} />);
    expect(container.querySelector("aside")).toBeNull();
    rightPanel.open("s2");
    const sub = { ...session, id: "s2", parentId: "s1" } as unknown as Session;
    const r = render(<RightPanel session={sub} onOpenFile={noop} onOpenDiff={noop} />);
    expect(r.container.querySelector("aside")).toBeNull();
  });

  it("shows the sections the thread's state has, opens on the default and switches", () => {
    state.agents = [agent("a1", "running"), agent("a2", "done")];
    rightPanel.open("s1");
    render(<RightPanel session={session} onOpenFile={noop} onOpenDiff={noop} />);
    const tabs = screen.getAllByRole("tab").map((t) => t.getAttribute("aria-label"));
    expect(tabs).toEqual(["Activity", "Agents", "Changes", "Notes", "Files", "Build", "Debug"]); // a dev build (vitest) lists Debug
    // The Activity section's subagents row opens the Agents section.
    fireEvent.click(screen.getByTestId("activity-body"));
    expect(rightPanel.get("s1").section).toBe("agents");
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    fireEvent.click(screen.getByRole("tab", { name: "Agents" }));
    expect(screen.getByTestId("agents-body")).toBeTruthy();
    expect(rightPanel.get("s1").section).toBe("agents");
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    expect(screen.getByTestId("notes-body")).toBeTruthy();
  });

  it("the header is a segmented control of named icon segments, with no scroll box", () => {
    rightPanel.open("s1");
    render(<RightPanel session={session} onOpenFile={noop} onOpenDiff={noop} />);
    const list = screen.getByRole("tablist", { name: "Panel sections" });
    expect(list.getAttribute("data-variant")).toBe("default");
    expect(list.className).not.toMatch(/overflow/);
    expect(list.querySelector("[data-slot=tabs-indicator]")).toBeTruthy();
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.getAttribute("aria-label")).toBeTruthy();
      expect(tab.textContent).toBe("");
      expect(tab.querySelector("svg")).toBeTruthy();
    }
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

  it("a loose chat in a workspace that is no repository has notes alone", () => {
    state.workspaces = [{ id: "w1", environmentId: "local", path: "/w", git: false }];
    const chat = { ...session, cwd: "/w", projectId: null, workspaceId: "w1" } as unknown as Session;
    rightPanel.open("s1");
    const r = render(<RightPanel session={chat} onOpenFile={noop} onOpenDiff={noop} />);
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("aria-label"))).toEqual(["Notes"]);
    r.unmount();
  });

  it("a background task alone gives the thread its Activity section, shown first", () => {
    state.meta = { id: "s1", status: "idle", background: { tasks: [{ id: "t1", label: "x", kind: "shell", startedAt: 0 }], agents: [], batch: null, watchingSince: null } } as unknown as SessionMeta;
    rightPanel.open("s1");
    render(<RightPanel session={session} onOpenFile={noop} onOpenDiff={noop} />);
    expect(screen.getAllByRole("tab")[0].getAttribute("aria-label")).toBe("Activity");
    expect(screen.getByTestId("activity-body")).toBeTruthy();
  });
});
