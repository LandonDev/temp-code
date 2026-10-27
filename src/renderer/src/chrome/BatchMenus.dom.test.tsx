// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { registry, type Environment, type Link } from "../lib/connection";
import { sessionStore } from "../lib/tcserver/store";
import type { SessionMeta, WorkspaceMeta } from "../lib/tcserver/types";
import { workspaceStore } from "../lib/tcserver/workspaces";
import { resetThreadBatchForTests, useBatchPending } from "../lib/threadBatch";
import { batchMenuRows } from "../lib/threadBatchMenu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { MenuRows } from "./menuBody";
import { HostsRow } from "./HostRows";
import { ProjectRail, projectMenuExtraItems } from "./ProjectRail";
import { groupMenuRows } from "./TabGroupMenu";

afterEach(() => {
  cleanup();
  sessionStore.reset();
  workspaceStore.reset();
  resetThreadBatchForTests();
  localStorage.clear();
  vi.restoreAllMocks();
});

const noop = () => {};

describe("the fleet switches as menu rows", () => {
  it("project menu: Customize… first, a row with nothing to act on is inert, a live one picks", () => {
    const onPick = vi.fn();
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent aria-label="Workspace actions">
          <MenuRows
            kind="dropdown"
            items={groupMenuRows({ actions: false, extra: projectMenuExtraItems(false, true, { pause: 3, resume: 0, stop: 3, archiveDone: 0 }) })}
            onPick={onPick}
          />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(screen.getAllByRole("menuitem")[0]!.textContent).toBe("Customize…");
    expect(screen.getByRole("menuitem", { name: "Resume all" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("menuitem", { name: "Stop all" }).getAttribute("data-variant")).toBe("destructive");
    expect(screen.getByRole("menuitem", { name: "Archive done" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Pause all" }));
    expect(onPick).toHaveBeenCalledWith("batch-pause");
  });

  it("the rows: Mark all read first, then the switches, zero rows disabled", () => {
    const onPick = vi.fn();
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent aria-label="Host actions">
          <MenuRows kind="dropdown" items={batchMenuRows({ pause: 0, resume: 2, stop: 0, archiveDone: 1 }, 4)} onPick={onPick} />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const names = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(names).toEqual(["Mark all read", "Pause all", "Resume all", "Stop all", "Archive done"]);
    expect(screen.getByRole("menuitem", { name: "Pause all" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("menuitem", { name: "Resume all" }).getAttribute("aria-disabled")).toBeNull();
    expect(screen.getAllByRole("menuitem").every((el) => el.querySelector("svg"))).toBe(true);
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark all read" }));
    expect(onPick).toHaveBeenCalledWith("read");
  });
});

// ── the rows as mounted: the rail's project menu and a host's row ─────────

const env = (id: string, name: string): Environment => ({ id, name, routes: [], credentialRef: null });
const HOSTS = [env("local", "This Mac"), env("env_box", "box")];
const MAC = "/Users/me/IdeaProjects/app";
const BOX = "/srv/agents/work/app";
const WORKSPACES = [
  { id: "w-mac", name: "app", path: MAC, git: true, createdAt: 1, environmentId: "local", linkId: "wl_app" },
  { id: "w-box", name: "app", path: BOX, git: true, createdAt: 1, environmentId: "env_box", linkId: "wl_app" },
] as WorkspaceMeta[];
const thread = (id: string, environmentId: string, workspaceId: string, status: SessionMeta["status"]): SessionMeta =>
  ({
    id,
    environmentId,
    workspaceId,
    parentId: null,
    projectId: null,
    threadType: "chat",
    title: id,
    cwd: WORKSPACES.find((w) => w.id === workspaceId)!.path,
    status,
    archived: false,
    pinned: false,
    busySince: null,
    createdAt: 1,
    updatedAt: 1,
  }) as SessionMeta;
const THREADS = [thread("mac-run", "local", "w-mac", "running"), thread("box-run", "env_box", "w-box", "running")];

const link = (environmentId: string): Link => ({
  environmentId,
  connected: true,
  profile: "local",
  request: <T,>(method: string) =>
    Promise.resolve(
      (method === "workspace.list"
        ? WORKSPACES.filter((w) => w.environmentId === environmentId)
        : method === "project.list"
          ? []
          : method === "session.list"
            ? THREADS.filter((t) => t.environmentId === environmentId)
            : null) as T,
    ),
  onPush: () => () => {},
  onOpen: () => () => {},
  onClose: () => () => {},
});

function Pending() {
  const pending = useBatchPending();
  return <output data-testid="pending">{pending ? JSON.stringify(pending) : ""}</output>;
}

async function mountTwoHosts(ui: React.ReactNode) {
  vi.spyOn(registry, "environmentsSnapshot").mockReturnValue(HOSTS);
  vi.spyOn(registry, "environment").mockImplementation((id) => HOSTS.find((e) => e.id === id));
  for (const host of HOSTS) {
    workspaceStore.attach(link(host.id));
    sessionStore.attach(link(host.id));
  }
  await act(() => new Promise((r) => setTimeout(r, 0)));
  render(
    <>
      {ui}
      <Pending />
    </>,
  );
}

describe("the fleet switches as mounted", () => {
  it("the rail's project menu acts on every copy of a linked workspace", async () => {
    await mountTwoHosts(
      <ProjectRail cwd="~" recents={[{ path: MAC, openedAt: 2 }, { path: BOX, openedAt: 1 }]} onSelectProject={noop} onOpenProject={noop} />,
    );
    const options = screen.getAllByRole("button", { name: "Workspace options" });
    expect(options).toHaveLength(1);
    fireEvent.click(options[0]);
    expect((await screen.findByRole("menuitem", { name: "Resume all" })).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Pause all" }));
    const pending = JSON.parse(screen.getByTestId("pending").textContent ?? "null");
    expect(pending).toMatchObject({ action: "pause", scope: { kind: "project", path: MAC, paths: [MAC, BOX], name: "app" } });
  });

  it("a host's submenu in the Hosts row runs them on that host alone", async () => {
    await mountTwoHosts(<HostsRow onAddWorkspace={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /^Hosts:/ }));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^box/ }));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pause all" }));
    const pending = JSON.parse(screen.getByTestId("pending").textContent ?? "null");
    expect(pending).toEqual({ action: "pause", scope: { kind: "host", environmentId: "env_box", name: "box" } });
  });
});
