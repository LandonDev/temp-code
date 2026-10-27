// @vitest-environment jsdom
/**
 * The master board's add sheet across linked copies: every connected host is
 * offered; a host holding the project's copy starts the thread in it, one
 * without a copy is asked with a dry run and gets its copy made before
 * `session.create`, and one with no checkout is disabled with its note.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ProjectMeta, WorkspaceMeta } from "../../../lib/tcserver/types";

const h = vi.hoisted(() => ({
  projects: [] as ProjectMeta[],
  workspaces: [] as WorkspaceMeta[],
  environments: [] as { id: string; name: string }[],
  statuses: new Map<string, { transport: string; fresh: boolean }>(),
  ensure: vi.fn(),
  startThread: vi.fn(),
}));

vi.mock("../../../lib/connection/status", () => ({
  useEnvironments: () => h.environments,
  useEnvironmentStatuses: () => h.statuses,
}));
vi.mock("../../../lib/tcserver/workspaces", () => ({
  useProjects: () => h.projects,
  useWorkspaces: () => h.workspaces,
}));
vi.mock("../../../lib/tcserver/commands", () => ({ startThread: (...args: unknown[]) => h.startThread(...args) }));
vi.mock("../../../lib/projectHostChoice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/projectHostChoice")>()),
  ensureLinkedOn: (...args: unknown[]) => h.ensure(...args),
}));
vi.mock("../../../chrome/ModelPicker", () => ({ ModelPicker: () => <span /> }));

import { AddThreadDialog, hostChoices } from "./AddThreadDialog";
import { loadLinkHosts } from "../../../lib/projectHostChoice";
import { tooltipChunk, warmTooltips } from "@renderer/components/ui/tooltip";

const ws = (over: Partial<WorkspaceMeta>): WorkspaceMeta =>
  ({ id: "w", environmentId: "local", name: "temp-code", path: "/Users/me/temp-code", git: true, linkId: "wl_a", createdAt: 1, ...over }) as WorkspaceMeta;
const proj = (over: Partial<ProjectMeta>): ProjectMeta => ({
  id: "p-mac",
  environmentId: "local",
  workspaceId: "w",
  name: "temp-code",
  mode: "local",
  branch: null,
  cwd: "/Users/me/temp-code",
  archived: false,
  linkId: "pl_a",
  createdAt: 1,
  ...over,
});

const master = {
  id: "m",
  environmentId: "local",
  title: "Batch",
  cwd: "/Users/me/temp-code",
  projectId: "p-mac",
  workspaceId: "w",
  provider: "claude",
  model: "claude-opus-5-5",
  reasoning: "high",
  context1m: false,
} as never;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  localStorage.clear();
  h.projects = [proj({}), proj({ id: "p-box", environmentId: "box", workspaceId: "w-box", cwd: "/srv/agents/work/temp-code" })];
  h.workspaces = [ws({}), ws({ id: "w-box", environmentId: "box", path: "/srv/agents/work/temp-code" })];
  h.environments = [
    { id: "local", name: "This Mac" },
    { id: "box", name: "The box" },
    { id: "mini", name: "Mini" },
  ];
  h.statuses = new Map(["local", "box", "mini"].map((id) => [id, { transport: "open", fresh: true }]));
  h.ensure.mockReset();
  h.startThread.mockReset();
  h.startThread.mockResolvedValue({ id: "new" });
  h.ensure.mockResolvedValue({ cwd: null, exists: false, project: null, note: "no checkout of temp-code" });
});
afterEach(() => {
  cleanup();
  // The modal's portal outlives the unmount while its exit runs.
  document.body.innerHTML = "";
});

const hostButton = (name: string) => within(screen.getByRole("group", { name: "Host" })).getByRole("button", { name }) as HTMLButtonElement;

describe("hostChoices across linked copies", () => {
  it("the master's project at home, the linked copy where there is one, the link facts where there is none", () => {
    const choices = hostChoices(
      { environmentId: "local", cwd: "/Users/me/temp-code", projectId: "p-mac" },
      h.environments,
      h.workspaces,
      h.projects,
    );
    expect(choices.map((c) => [c.id, c.target])).toEqual([
      ["local", { projectId: "p-mac" }],
      ["box", { projectId: "p-box" }],
      ["mini", { ensure: expect.objectContaining({ projectLinkId: "pl_a", workspaceLinkId: "wl_a", name: "temp-code" }) }],
    ]);
  });
});

describe("AddThreadDialog", () => {
  it("a host with a checkout but no copy gets one before the thread starts there", async () => {
    const made = proj({ id: "p-mini", environmentId: "mini", workspaceId: "w-mini", cwd: "/work/temp-code" });
    h.ensure.mockImplementation((_env: string, _args: unknown, dryRun?: boolean) =>
      Promise.resolve(dryRun ? { cwd: "/work/temp-code", exists: false, project: null, note: null } : { cwd: "/work/temp-code", exists: false, project: made, note: null }),
    );
    render(<AddThreadDialog master={master} siblings={[]} onClose={() => {}} />);
    await flush();
    expect(h.ensure).toHaveBeenCalledWith("mini", expect.objectContaining({ projectLinkId: "pl_a" }), true);
    expect(hostButton("Mini").disabled).toBe(false);
    fireEvent.click(hostButton("Mini"));
    expect(hostButton("Mini").getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByLabelText("Brief"), { target: { value: "Port the view." } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await flush();
    expect(h.ensure).toHaveBeenLastCalledWith("mini", expect.objectContaining({ projectLinkId: "pl_a" }));
    expect(h.startThread).toHaveBeenCalledTimes(1);
    expect(h.startThread.mock.calls[0][0]).toMatchObject({ environmentId: "mini", projectId: "p-mini", masterId: "m", startedBy: "m" });
    expect(loadLinkHosts()).toEqual({ pl_a: "mini" });
  });

  it("a host with no checkout is disabled with the host's note, and a host with a copy needs no dry run", async () => {
    render(<AddThreadDialog master={master} siblings={[]} onClose={() => {}} />);
    await flush();
    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(hostButton("Mini").disabled).toBe(true);
    // The note hangs on a Tooltip over the disabled choice, never a title=.
    expect(hostButton("Mini").hasAttribute("title")).toBe(false);
    // The tooltip's primitive loads on the first hover anywhere and swaps in
    // once focus leaves the brief; load it and let go of focus first.
    await act(async () => {
      (document.activeElement as HTMLElement | null)?.blur();
      warmTooltips();
      await tooltipChunk.load();
      await Promise.resolve();
    });
    const wrapper = hostButton("Mini").closest("[data-choice-note]") as HTMLElement;
    await act(async () => {
      fireEvent.pointerEnter(wrapper, { pointerType: "mouse" });
      fireEvent.mouseEnter(wrapper);
      fireEvent.mouseMove(wrapper);
      await new Promise((r) => setTimeout(r, 500));
    });
    expect((await screen.findByText("no checkout of temp-code")).closest("[data-slot=tooltip-content]")).toBeTruthy();
    expect(hostButton("The box").disabled).toBe(false);
    fireEvent.click(hostButton("The box"));
    fireEvent.change(screen.getByLabelText("Brief"), { target: { value: "Port the view." } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await flush();
    expect(h.startThread.mock.calls[0][0]).toMatchObject({ environmentId: "box", projectId: "p-box" });
  });

  it("Escape with After's list open closes the list and leaves the dialog open", async () => {
    const onClose = vi.fn();
    render(<AddThreadDialog master={master} siblings={[{ id: "s1", title: "Search" }]} onClose={onClose} />);
    await flush();
    const after = screen.getByRole("combobox", { name: "After" });
    await act(async () => {
      fireEvent.click(after);
    });
    const option = await screen.findByRole("option", { name: "Search" });
    await act(async () => {
      fireEvent.keyDown(option, { key: "Escape" });
    });
    await flush();
    expect(screen.queryByRole("option", { name: "Search" })).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    // A second Escape, with the list shut, is the dialog's.
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Add closes through the dialog's exit and calls onClose once", async () => {
    const onClose = vi.fn();
    const onAdded = vi.fn();
    render(<AddThreadDialog master={master} siblings={[]} onClose={onClose} onAdded={onAdded} />);
    await flush();
    expect(document.activeElement).toBe(screen.getByLabelText("Brief"));
    fireEvent.change(screen.getByLabelText("Brief"), { target: { value: "Port the view." } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await flush();
    await flush();
    expect(onAdded).toHaveBeenCalledWith({ id: "new" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
