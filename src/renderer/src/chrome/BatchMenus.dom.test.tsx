// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { registry, type Environment, type Link } from "../lib/connection";
import { sessionStore } from "../lib/tcserver/store";
import type { SessionMeta, WorkspaceMeta } from "../lib/tcserver/types";
import { workspaceStore } from "../lib/tcserver/workspaces";
import { resetThreadBatchForTests, useBatchPending } from "../lib/threadBatch";
import { batchExplorerItems, batchMenuExtraItems } from "../lib/threadBatchMenu";
import { ExplorerMenu } from "./ExplorerMenu";
import { HostRows } from "./HostRows";
import { ProjectRail } from "./ProjectRail";
import { TabGroupMenu } from "./TabGroupMenu";

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
  it("project menu: a row with nothing to act on is inert, a live one picks and closes", () => {
    const onExtraPick = vi.fn();
    const onClose = vi.fn();
    render(
      <TabGroupMenu
        environmentId="local"
        x={10}
        y={10}
        groupId="g"
        label="temp-code"
        colorIndex={null}
        customColor={null}
        currentColor="#888"
        logoPath={null}
        mascotName={null}
        mascotProject="g"
        onRename={noop}
        onColorChange={noop}
        onCustomColorChange={noop}
        onMascotChange={noop}
        onLogoChange={noop}
        onPick={noop}
        onClose={onClose}
        showActions={false}
        extraItems={batchMenuExtraItems({ pause: 3, resume: 0, stop: 3, archiveDone: 0 })}
        onExtraPick={onExtraPick}
      />,
    );
    const resume = screen.getByRole("menuitem", { name: "Resume all" }) as HTMLButtonElement;
    expect(resume.disabled).toBe(true);
    fireEvent.click(resume);
    expect(onExtraPick).not.toHaveBeenCalled();
    const stop = screen.getByRole("menuitem", { name: "Stop all" }) as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    expect(stop.className).toContain("text-danger");
    fireEvent.click(screen.getByRole("menuitem", { name: "Pause all" }));
    expect(onExtraPick).toHaveBeenCalledWith("batch-pause");
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByRole("menuitem", { name: "Archive done" })).toBeTruthy();
  });

  it("host menu: Mark all read first, then the switches, zero rows disabled", () => {
    const onPick = vi.fn();
    render(
      <ExplorerMenu
        x={0}
        y={0}
        ariaLabel="Host actions"
        items={batchExplorerItems({ pause: 0, resume: 2, stop: 0, archiveDone: 1 }, 4)}
        onClose={noop}
        onPick={onPick}
      />,
    );
    const names = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(names).toEqual(["Mark all read", "Pause all", "Resume all", "Stop all", "Archive done"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pause all" }));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Resume all" }));
    expect(onPick).toHaveBeenCalledWith("batch-resume");
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
    expect((screen.getByRole("menuitem", { name: "Resume all" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pause all" }));
    const pending = JSON.parse(screen.getByTestId("pending").textContent ?? "null");
    expect(pending).toMatchObject({ action: "pause", scope: { kind: "project", path: MAC, paths: [MAC, BOX], name: "app" } });
  });

  it("a host's row runs them on that host alone", async () => {
    await mountTwoHosts(<HostRows onAddWorkspace={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /^box,/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pause all" }));
    const pending = JSON.parse(screen.getByTestId("pending").textContent ?? "null");
    expect(pending).toEqual({ action: "pause", scope: { kind: "host", environmentId: "env_box", name: "box" } });
  });
});
