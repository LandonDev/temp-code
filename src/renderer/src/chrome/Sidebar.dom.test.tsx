// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta, WorkspaceMeta } from "../lib/tcserver/types";

const ws = { id: "w1", name: "alpha", path: "/w/alpha", environmentId: "local", createdAt: 1 } as WorkspaceMeta;
const where = vi.hoisted(() => ({ cwd: "/w/alpha", workspaceId: "w1" as string | null, columns: [] as (string | null)[] }));

vi.mock("../stores/project", () => ({
  useProject: (pick: (s: { projectCwd: string; selectedProjectId: null }) => unknown) =>
    pick({ projectCwd: where.cwd, selectedProjectId: null }),
  useProjectCwds: () => ({ activeTab: null, active: null, sidebarCwd: where.cwd, gitCwd: where.cwd }),
  useRailRecents: () => [],
  useSelectedWorkspaceId: () => where.workspaceId,
  useSelectedWorkspaceIds: () => (where.workspaceId ? [where.workspaceId] : null),
}));
vi.mock("../lib/tcserver/workspaces", () => ({
  useWorkspaces: () => [ws],
  useWorkspaceCatalog: () => ({ projects: [], workspaces: [ws] }),
  workspaceStore: { getSnapshot: () => ({ projects: [], workspaces: [ws] }) },
  workspaceIdOf: () => "w1",
  workspaceLabelKey: (_: unknown, __: string, fallback: string) => fallback,
}));
vi.mock("./ProjectRail", () => ({ ProjectRail: () => <nav data-testid="rail" />, RailFoot: () => <div data-testid="foot" /> }));
vi.mock("./WorkspaceSessions", async () => {
  const { useState } = await import("react");
  return {
    // Records the scope each mounted column was born with.
    default: ({ workspaceId }: { workspaceId: string | null }) => {
      useState(() => where.columns.push(workspaceId));
      return <div data-testid="threads" />;
    },
  };
});
vi.mock("../lib/monaco/focusBoot", () => ({ warmProjectForCwd: () => Promise.resolve() }));
const { archive } = vi.hoisted(() => ({ archive: vi.fn(async (_id: string, _archived: boolean) => {}) }));
vi.mock("../lib/tcserver/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tcserver/commands")>()),
  archive,
}));
// Every thread counts as seen.
vi.mock("../lib/sessionSeen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sessionSeen")>()),
  loadLastSeen: () => ({}),
  seenFloor: () => Number.POSITIVE_INFINITY,
}));

import { sessionStore } from "../lib/tcserver/store";
import { Sidebar } from "./Sidebar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  archive.mockClear();
  sessionStore.reset();
});

const mount = (onNew = vi.fn()) =>
  render(
    <div className="app-shell">
      <Sidebar
        onSelectSession={() => {}}
        onOpenFile={() => {}}
        onSelectProject={() => {}}
        onOpenProject={() => {}}
        onSelectProjectCard={() => {}}
        onNewChat={() => {}}
        onNew={onNew}
      />
    </div>,
  );

describe("the workspace column", () => {
  it("is the workspace's threads under one header: its name, New thread and its menu, no tabs", async () => {
    const onNew = vi.fn();
    mount(onNew);
    expect(screen.getByRole("heading", { name: "alpha" })).toBeTruthy();
    expect(screen.getByTestId("threads")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    expect(onNew).toHaveBeenCalledOnce();
    const menu = screen.getByRole("button", { name: "Workspace options" });
    expect(menu.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(menu);
    const list = await screen.findByRole("menu", { name: "Workspace actions" });
    expect(within(list).getByText("New chat")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Workspace options" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps a 40px content box under its hairline, as the title bar's rows do, so its controls sit on the strip's line", () => {
    mount();
    const header = screen.getByRole("heading", { name: "alpha" }).parentElement!;
    expect(header.className).toMatch(/\bbox-content\b/);
    expect(header.className).toMatch(/\bh-10\b/);
    expect(header.className).toMatch(/\bborder-b\b/);
  });

  it("resizes from a focusable sash by 2% or Shift 10% and resets on double-click", () => {
    const { container } = mount();
    vi.spyOn(container.querySelector(".app-shell")!, "getBoundingClientRect").mockReturnValue({ width: 1000 } as DOMRect);
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });
    const pane = handle.parentElement!;
    handle.focus();
    expect(document.activeElement).toBe(handle);
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.className).toContain("focus-visible:bg-accent");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.getAttribute("aria-valuenow")).toBe("280");
    expect(pane.style.width).toBe("280px");
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(handle.getAttribute("aria-valuenow")).toBe("380");
    expect(pane.style.width).toBe("380px");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(pane.style.width).toBe("360px");
    fireEvent.doubleClick(handle);
    expect(handle.getAttribute("aria-valuenow")).toBe("260");
    expect(pane.style.width).toBe("260px");
  });

  it("is headed Chats at the home", () => {
    where.cwd = "~";
    where.workspaceId = null;
    try {
      mount();
      expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
    } finally {
      where.cwd = "/w/alpha";
      where.workspaceId = "w1";
    }
  });

  it("mounts one column per scope, so a switch never carries one workspace's folds and pages into another", () => {
    where.columns = [];
    const view = mount();
    where.cwd = "~";
    where.workspaceId = null;
    try {
      view.rerender(
        <div className="app-shell">
          <Sidebar onSelectSession={() => {}} onOpenFile={() => {}} onSelectProject={() => {}} onOpenProject={() => {}} onSelectProjectCard={() => {}} onNewChat={() => {}} onNew={() => {}} />
        </div>,
      );
      expect(where.columns).toEqual(["w1", null]);
    } finally {
      where.cwd = "/w/alpha";
      where.workspaceId = "w1";
    }
  });
});

describe("the workspace menu's Archive dormant", () => {
  const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
    ({ environmentId: "local", id, parentId: null, projectId: "p1", workspaceId: "w1", threadType: "chat", title: id, cwd: "/w/alpha", status: "idle", archived: false, pinned: false, busySince: null, createdAt: 1, updatedAt: 100, ...extra }) as SessionMeta;

  it("counts the roots, never a thread housed in a batch, and archives a master's settled batch with it", async () => {
    const metas = [
      meta("master", { isMaster: true }),
      meta("b-done", { threadType: "implementation", masterId: "master", status: "done" }),
      meta("b-busy", { threadType: "implementation", masterId: "master", status: "running" }),
      meta("plain"),
    ];
    for (const m of metas) sessionStore.injectPush({ push: "session", session: m }, "local");
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Workspace options" }));
    const list = await screen.findByRole("menu", { name: "Workspace actions" });
    fireEvent.click(within(list).getByRole("menuitem", { name: "Archive 2 dormant threads" }));
    await waitFor(() => expect(archive).toHaveBeenCalledTimes(3));
    expect(archive.mock.calls.map(([id]) => id)).toEqual(["b-done", "master", "plain"]);
  });
});
