// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceMeta } from "../lib/tcserver/types";

const ws = { id: "w1", name: "alpha", path: "/w/alpha", environmentId: "local", createdAt: 1 } as WorkspaceMeta;
const where = vi.hoisted(() => ({ cwd: "/w/alpha", workspaceId: "w1" as string | null }));

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
  workspaceIdOf: () => "w1",
  workspaceLabelKey: (_: unknown, __: string, fallback: string) => fallback,
}));
vi.mock("./ProjectRail", () => ({ ProjectRail: () => <nav data-testid="rail" />, RailFoot: () => <div data-testid="foot" /> }));
vi.mock("./WorkspaceSessions", () => ({ default: () => <div data-testid="threads" /> }));
vi.mock("../lib/monaco/focusBoot", () => ({ warmProjectForCwd: () => Promise.resolve() }));

import { Sidebar } from "./Sidebar";

afterEach(cleanup);

const mount = (onNew = vi.fn()) =>
  render(
    <Sidebar
      onSelectSession={() => {}}
      onOpenFile={() => {}}
      onSelectProject={() => {}}
      onOpenProject={() => {}}
      onSelectProjectCard={() => {}}
      onNewChat={() => {}}
      onNew={onNew}
    />,
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
});
