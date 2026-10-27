// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "../lib/tcserver/types";

const state = vi.hoisted(() => ({
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
}));
vi.mock("../lib/tcserver/projects", () => ({ projectForCwd: (cwd: string) => (cwd === "/p" ? { id: "p1", environmentId: "local", cwd: "/p", name: "P" } : undefined) }));
vi.mock("../lib/devServers", () => ({ useDevRunning: () => state.devRunning }));
vi.mock("../lib/activity", () => ({ useActivity: () => ({ rows: [], meta: null }) }));
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
vi.mock("../chrome/rail/BranchPanel", () => ({ BranchPanel: () => <div>branch</div> }));
vi.mock("../chrome/rail/BuildPanel", () => ({ BuildPanel: () => <div>build</div> }));
vi.mock("../chrome/rail/DevServerPanel", () => ({ DevServerPanel: () => <div>dev</div> }));
vi.mock("../chrome/rail/DebugPanel", () => ({ default: () => <div>debug</div> }));
vi.mock("../chrome/FileTree", () => ({ FileTree: () => <div data-testid="files-body">files</div> }));

import { rightPanel } from "../lib/rightPanel";
import type { Session } from "../lib/session";
import { RightPanel } from "./RightPanel";

const session = { id: "s1", environmentId: "local", title: "T", cwd: "/p", projectId: "p1", status: "idle", blocks: [] } as unknown as Session;
const agent = (id: string, status: string) => ({ id, status, parentId: "s1" }) as unknown as SessionMeta;
const noop = () => {};

beforeEach(() => {
  rightPanel.reset();
  state.agents = [];
  state.meta = null;
  state.devRunning = false;
});
afterEach(cleanup);

describe("RightPanel", () => {
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
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Activity", "Agents", "Changes", "Notes", "Files", "Branch", "Build", "Dev", "Debug"]); // a dev build (vitest) lists Debug
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

  it("a remembered section that no longer exists falls back to the default; the close button closes", () => {
    rightPanel.open("s1", "agents");
    render(<RightPanel session={session} onOpenFile={noop} onOpenDiff={noop} />);
    expect(screen.getByTestId("changes-body")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Agents" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hide panel" }));
    expect(rightPanel.get("s1").open).toBe(false);
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("a chat with no project has notes alone", () => {
    const chat = { ...session, cwd: "~", projectId: null } as unknown as Session;
    rightPanel.open("s1");
    const r = render(<RightPanel session={chat} onOpenFile={noop} onOpenDiff={noop} />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Notes"]);
    r.unmount();
  });

  it("a background task alone gives the thread its Activity section, shown first", () => {
    state.meta = { id: "s1", status: "idle", background: { tasks: [{ id: "t1", label: "x", kind: "shell", startedAt: 0 }], agents: [], batch: null, watchingSince: null } } as unknown as SessionMeta;
    rightPanel.open("s1");
    render(<RightPanel session={session} onOpenFile={noop} onOpenDiff={noop} />);
    expect(screen.getAllByRole("tab")[0].textContent).toBe("Activity");
    expect(screen.getByTestId("activity-body")).toBeTruthy();
  });
});
