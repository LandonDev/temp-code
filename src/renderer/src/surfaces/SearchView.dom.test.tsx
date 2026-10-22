// @vitest-environment jsdom
import { act, fireEvent, render, type RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The search surface over two hosts: one row per hit kind (thread title,
 * transcript row, file name, file content, note, project), each with the
 * rail's host mark when two hosts are paired and none with one; the file
 * both hosts hold is one row on the newer copy; the footer times each
 * host; arrows and Enter open where the hit lives, ⌘↩ beside.
 */

const h = vi.hoisted(() => {
  const envs = {
    two: [
      { id: "local", name: "This Mac", routes: [], credentialRef: null },
      { id: "env_box", name: "box", routes: [], credentialRef: null },
    ],
    one: [{ id: "local", name: "This Mac", routes: [], credentialRef: null }],
  };
  return {
    envs,
    environments: envs.two as { id: string; name: string }[],
    statuses: new Map([["env_box", { transport: "open", fresh: true }]]),
    invokeOn: vi.fn(),
    searchProject: vi.fn(),
    listProjectFiles: vi.fn(),
    metas: [
      { id: "s-local", environmentId: "local", parentId: null, archived: false, cwd: "/Users/me/app", provider: "claude", title: "Gateway trace", updatedAt: 5 },
      { id: "s-box", environmentId: "env_box", parentId: null, archived: false, cwd: "/work/app", provider: "codex", title: "Box thread", updatedAt: 6 },
    ],
    workspaces: [
      { id: "w1", environmentId: "local", name: "app", path: "/Users/me/app", git: true, createdAt: 1 },
      { id: "w2", environmentId: "env_box", name: "app", path: "/work/app", git: true, createdAt: 1 },
    ],
  };
});

vi.mock("../lib/connection", () => ({
  registry: { primaryEnvironmentId: "local", primary: () => ({ environmentId: "local" }) },
  useEnvironments: () => h.environments,
  useEnvironmentStatuses: () => h.statuses,
}));
vi.mock("../lib/tcserver/store", () => ({
  sessionStore: { get: () => undefined },
  useServerSessions: () => [],
  useSessionMetas: () => h.metas,
}));
vi.mock("../lib/tcserver/workspaces", () => ({ useWorkspaces: () => h.workspaces, useWorkspaceIcon: () => undefined }));
vi.mock("../lib/tcserver/projects", () => ({
  hostOfCwd: (cwd: string) => (cwd.startsWith("/work") ? "env_box" : "local"),
  environmentOfCwd: (cwd: string) => (cwd.startsWith("/work") ? "env_box" : "local"),
}));
vi.mock("../lib/connection/status", () => ({ useEnvironments: () => h.environments }));
vi.mock("../lib/native", () => ({ invokeOn: (...args: unknown[]) => h.invokeOn(...args), nativePlatform: () => "darwin" }));
vi.mock("../lib/search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/search")>()),
  searchProject: (...args: unknown[]) => h.searchProject(...args),
}));
vi.mock("../lib/fs", () => ({ listProjectFiles: (...args: unknown[]) => h.listProjectFiles(...args) }));
vi.mock("../lib/fileIndex", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/fileIndex")>();
  const files = [{ name: "gateway.ts", path: "/Users/me/app/src/gateway.ts", relative: "src/gateway.ts" }];
  return { ...real, peekProjectFiles: () => files, loadProjectFiles: () => Promise.resolve(files), recentOpenedFiles: () => [] };
});
vi.mock("../lib/settings", () => ({ loadNotesEnabled: () => true }));
vi.mock("../lib/session", () => ({ sessionDisplayTitle: (title: string) => title }));
vi.mock("../lib/projectLogos", () => ({ projectLogoSrc: () => null }));
vi.mock("../lib/tabGroups", () => ({ TAB_GROUP_LOGOS_CHANGED: "x", tabGroupLogoDisplayRevision: () => 0 }));
vi.mock("../chrome/TitleBar", () => ({ OverlayNav: () => <span /> }));
vi.mock("../chrome/WindowControls", () => ({ WindowControls: () => <span /> }));
vi.mock("../chrome/EnvironmentSwitcher", () => ({ toneOf: () => "bg-success" }));
vi.mock("../chrome/FileTypeIcon", () => ({ FileTypeIcon: () => <span data-icon="file" /> }));
vi.mock("../chrome/HarnessIcon", () => ({ HarnessIcon: () => <span data-icon="harness" /> }));
vi.mock("./threads/bits", () => ({ MatrixSpinner: () => <span data-spinner /> }));

import { SearchView } from "./SearchView";

const recents = [{ path: "/Users/me/gateway-kit", lastOpened: 1 }] as never;

function answers(): void {
  h.invokeOn.mockImplementation((env: string, method: string) => {
    if (method === "search_sessions") {
      return Promise.resolve({
        hits: env === "env_box" ? [{ sessionId: "s-box", seq: 4, role: "assistant", snippet: "the gateway on the box", ts: 1, rank: -3 }] : [],
        truncated: false,
      });
    }
    if (method === "notes_search") {
      return Promise.resolve({
        hits: env === "env_box" ? [{ id: "n1", title: "Gateway notes", snippet: "about the gateway", updatedAt: Date.now() }] : [],
        truncated: false,
      });
    }
    return Promise.reject(new Error(`unexpected ${method}`));
  });
  h.searchProject.mockImplementation((env: string, options: { cwd: string }) =>
    Promise.resolve({
      matches: [
        { path: `${options.cwd}/src/gw.ts`, relative: "src/gw.ts", line: 3, column: 1, preview: "gateway()", mtime: env === "env_box" ? 200 : 100 },
      ],
      truncated: false,
    }),
  );
  h.listProjectFiles.mockResolvedValue([]);
}

const props = () => ({
  onOpenFile: vi.fn(),
  onOpenFileBeside: vi.fn(),
  onOpenSession: vi.fn(),
  onOpenSessionBeside: vi.fn(),
  onOpenProject: vi.fn(),
  onOpenNote: vi.fn(),
  onClose: vi.fn(),
});

async function search(view: RenderResult, text: string): Promise<void> {
  const input = view.container.querySelector("input") as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { value: text } });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(260);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
}

const rows = (view: RenderResult) => [...view.container.querySelectorAll('[role="option"]')] as HTMLButtonElement[];
const kinds = (view: RenderResult) => rows(view).map((row) => row.dataset.kind);
/** The row's host glyph: its host's name on hover, and "newer" beside it on a folded file. */
const hostOf = (row: HTMLElement) => {
  const mark = row.querySelector("[data-host-mark]");
  if (!mark) return null;
  const name = mark.querySelector("[data-host-glyph]")?.getAttribute("title") ?? "";
  return mark.textContent ? `${name} · ${mark.textContent}` : name;
};

describe("SearchView across hosts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Element.prototype.scrollIntoView = () => {};
    h.environments = h.envs.two;
    answers();
  });
  afterEach(() => {
    vi.useRealTimers();
    h.invokeOn.mockReset();
    h.searchProject.mockReset();
    h.listProjectFiles.mockReset();
  });

  it("renders one row per kind with the host glyph, folds the paired file into the newer copy, and times each host", async () => {
    const p = props();
    const view = render(<SearchView open cwd="/Users/me/app" recents={recents} {...p} />);
    await search(view, "gateway");

    expect(kinds(view)).toEqual(["conversation", "message", "file", "content", "note", "project"]);
    const [thread, message, file, content, note, project] = rows(view);
    expect(thread.textContent).toContain("Gateway trace");
    expect(hostOf(thread)).toBe("This Mac");
    expect(message.textContent).toContain("the gateway on the box");
    expect(hostOf(message)).toBe("box");
    expect(file.textContent).toContain("gateway.ts");
    expect(hostOf(file)).toBe("This Mac");
    // Both hosts hold src/gw.ts:3; the box's copy is newer, so one row, on the box.
    expect(content.textContent).toContain("src/gw.ts:3");
    expect(hostOf(content)).toBe("box · also on This Mac · newer");
    expect(content.querySelector("[data-host-glyph]")?.getAttribute("data-host-kind")).toBe("server");
    expect(thread.querySelector("[data-host-glyph]")?.getAttribute("data-host-kind")).toBe("mac");
    expect(note.textContent).toContain("about the gateway");
    expect(hostOf(note)).toBe("box");
    expect(project.textContent).toContain("gateway-kit");

    // Every host asked: both answered, each with its time.
    const footer = view.getByLabelText("Hosts searched");
    expect(footer.textContent).toMatch(/^This Mac: \d+ ms(box|This Mac)/);
    expect(footer.textContent).toMatch(/box: \d+ ms/);
    expect(view.container.querySelector("[data-spinner]")).toBeNull();
    // Filters hint: one line, host: present because two hosts are paired.
    expect(view.getByLabelText("Filters").textContent).toBe("host:mac, boxtype:thread,file,note,projectproject:name");
    // No entrance animation on any row.
    for (const row of rows(view)) expect(row.className).not.toMatch(/animate|transition/);
    view.unmount();
  });

  it("opens a hit where it lives on Enter and beside on ⌘↩; arrows move the active row", async () => {
    const p = props();
    const view = render(<SearchView open cwd="/Users/me/app" recents={recents} {...p} />);
    await search(view, "gateway");
    const input = view.container.querySelector("input") as HTMLInputElement;
    expect(rows(view)[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(rows(view)[1].getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe("app-search-hit-1");
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(p.onOpenSessionBeside).toHaveBeenCalledWith("s-box", 4);
    expect(p.onOpenSession).not.toHaveBeenCalled();
    expect(p.onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    // The folded content row opens on the box's copy.
    expect(p.onOpenFile).toHaveBeenCalledWith("/work/app/src/gw.ts", { line: 3, column: 1 });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(p.onOpenNote).toHaveBeenCalledWith("env_box", "n1");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(p.onOpenFile).toHaveBeenCalledWith("/Users/me/app/src/gateway.ts");
    view.unmount();
  });

  it("host: narrows to one host, type: to one kind, and a skipped host is said so", async () => {
    h.statuses = new Map();
    const p = props();
    const view = render(<SearchView open cwd="/Users/me/app" recents={recents} {...p} />);
    await search(view, "gateway type:thread");
    expect(kinds(view)).toEqual(["conversation"]);
    expect(view.getByLabelText("Hosts searched").textContent).toContain("box: skipped (offline)");
    expect(view.getByLabelText("Filters").textContent).toContain("type:thread");

    h.statuses = new Map([["env_box", { transport: "open", fresh: true }]]);
    await search(view, "gateway host:box");
    expect(kinds(view)).toEqual(["message", "content", "note"]);
    expect(view.getByLabelText("Filters").textContent).toContain("host:box");
    expect(view.getByLabelText("Hosts searched").textContent).not.toContain("This Mac");
    view.unmount();
  });

  it("with one host there is no host mark, no host: hint and the footer still times it", async () => {
    h.environments = h.envs.one;
    h.workspaces = [h.workspaces[0]];
    const p = props();
    const view = render(<SearchView open cwd="/Users/me/app" recents={recents} {...p} />);
    await search(view, "gateway");
    expect(kinds(view)).toEqual(["conversation", "file", "content", "project"]);
    expect(view.container.querySelector("[data-host-mark]")).toBeNull();
    expect(view.getByLabelText("Filters").textContent).not.toContain("host:");
    expect(view.getByLabelText("Hosts searched").textContent).toMatch(/^This Mac: \d+ ms$/);
    view.unmount();
  });
});
