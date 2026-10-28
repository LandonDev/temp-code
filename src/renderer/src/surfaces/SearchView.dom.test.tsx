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
    recentFiles: [] as string[],
    metas: [
      { id: "s-local", environmentId: "local", parentId: null, archived: false, cwd: "/Users/me/app", provider: "claude", title: "Gateway trace", updatedAt: 5 },
      { id: "s-box", environmentId: "env_box", parentId: null, archived: false, cwd: "/work/app", provider: "codex", title: "Box thread", updatedAt: 6 },
      { id: "s-alpha", environmentId: "local", parentId: null, archived: false, cwd: "/Users/me/alpha", provider: "claude", title: "Alpha thread", updatedAt: 7 },
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
  const files = [
    { name: "gateway.ts", path: "/Users/me/app/src/gateway.ts", relative: "src/gateway.ts" },
    { name: "README.md", path: "/Users/me/app/README.md", relative: "README.md" },
  ];
  return { ...real, peekProjectFiles: () => files, loadProjectFiles: () => Promise.resolve(files), recentOpenedFiles: () => h.recentFiles };
});
vi.mock("../lib/session", () => ({ sessionDisplayTitle: (title: string) => title }));
vi.mock("../lib/projectLogos", () => ({ projectLogoSrc: () => null }));
vi.mock("../lib/tabGroups", () => ({ TAB_GROUP_LOGOS_CHANGED: "x", tabGroupLogoDisplayRevision: () => 0 }));
vi.mock("../chrome/TitleBar", () => ({ OverlayNav: () => <span /> }));
vi.mock("../chrome/WindowControls", () => ({ WindowControls: () => <span /> }));
vi.mock("../chrome/FileTypeIcon", () => ({ FileTypeIcon: () => <span data-icon="file" /> }));
vi.mock("../chrome/HarnessIcon", () => ({ HarnessIcon: () => <span data-icon="harness" /> }));

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
    if (method === "notes_list") {
      return Promise.resolve(
        env === "env_box" ? [{ id: "n1", slug: "plan", title: "Plan", body: "# Plan\nShip the fold", createdAt: 1, updatedAt: 3 }] : [],
      );
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

/** Opens the field's filter menu and answers its rows by role and name. */
async function openFilters(view: RenderResult): Promise<HTMLElement> {
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Filters" }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  return view.baseElement.querySelector('[data-slot="dropdown-menu-content"]') as HTMLElement;
}
const menuLabels = (menu: HTMLElement) =>
  [...menu.querySelectorAll('[data-slot="dropdown-menu-label"]')].map((el) => el.textContent);
const menuItem = (menu: HTMLElement, name: string) =>
  [...menu.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"], [role="menuitemradio"]')].find(
    (el) => el.textContent === name,
  ) as HTMLElement;

const rows = (view: RenderResult) => [...view.container.querySelectorAll('[role="option"]')] as HTMLButtonElement[];
const kinds = (view: RenderResult) => rows(view).map((row) => row.dataset.kind);
/** The row's host glyph: its host's name on hover, and "newer" beside it on a folded file. */
const hostOf = (row: HTMLElement) => {
  const mark = row.querySelector("[data-host-mark]");
  if (!mark) return null;
  const name = mark.querySelector("[data-host-glyph]")?.getAttribute("aria-label") ?? "";
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
    expect(hostOf(content)).toBe("box, also on This Mac · newer");
    expect(content.querySelector("[data-host-glyph]")?.getAttribute("data-host-kind")).toBe("server");
    expect(thread.querySelector("[data-host-glyph]")?.getAttribute("data-host-kind")).toBe("mac");
    expect(note.textContent).toContain("about the gateway");
    expect(hostOf(note)).toBe("box");
    expect(project.textContent).toContain("gateway-kit");

    // Every host asked: both answered, each with its time.
    const footer = view.getByLabelText("Hosts searched");
    expect(footer.textContent).toMatch(/^This Mac: \d+ ms(box|This Mac)/);
    expect(footer.textContent).toMatch(/box: \d+ ms/);
    expect(view.container.querySelector('[data-slot="spinner"]')).toBeNull();
    // No hint line under the field: the filters live in the field's menu.
    expect(view.container.textContent).not.toContain("type:");
    // No entrance animation on any row.
    for (const row of rows(view)) {
      expect(row.className).not.toMatch(/animate|transition-\[/);
      expect(row.className).toContain("transition-none");
    }
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

    h.statuses = new Map([["env_box", { transport: "open", fresh: true }]]);
    await search(view, "gateway host:box");
    expect(kinds(view)).toEqual(["message", "content", "note"]);
    expect(view.getByLabelText("Hosts searched").textContent).not.toContain("This Mac");
    view.unmount();
  });

  it("with one host there is no host mark, no host: hint and no footer", async () => {
    h.environments = h.envs.one;
    h.workspaces = [h.workspaces[0]];
    const p = props();
    const view = render(<SearchView open cwd="/Users/me/app" recents={recents} {...p} />);
    await search(view, "gateway");
    expect(kinds(view)).toEqual(["conversation", "file", "content", "project"]);
    expect(view.container.querySelector("[data-host-mark]")).toBeNull();
    const menu = await openFilters(view);
    expect(menuLabels(menu)).toEqual(["Type", "Project"]);
    expect(view.queryByLabelText("Hosts searched")).toBeNull();
    view.unmount();
  });

  it("the filter menu reads the typed tokens and rewrites them", async () => {
    const p = props();
    const view = render(<SearchView open cwd="/Users/me/app" recents={recents} {...p} />);
    await search(view, "gateway");
    const input = view.container.querySelector("input") as HTMLInputElement;
    let menu = await openFilters(view);
    expect(menuLabels(menu)).toEqual(["Type", "Host", "Project"]);
    expect(menuItem(menu, "Files").getAttribute("aria-checked")).toBe("true");
    expect(menuItem(menu, "Any").getAttribute("aria-checked")).toBe("true");
    expect(menuItem(menu, "app")).toBeTruthy();

    await act(async () => {
      fireEvent.click(menuItem(menu, "Files"));
    });
    expect(input.value).toBe("gateway type:thread,note,project ");
    menu = view.baseElement.querySelector('[data-slot="dropdown-menu-content"]') as HTMLElement;
    expect(menuItem(menu, "Files").getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      fireEvent.click(menuItem(menu, "This Mac"));
    });
    expect(input.value).toBe("gateway type:thread,note,project host:box ");
    await act(async () => {
      fireEvent.click(menuItem(menu, "This Mac"));
    });
    expect(input.value).toBe("gateway type:thread,note,project ");
    await act(async () => {
      fireEvent.click(menuItem(menu, "app"));
    });
    expect(input.value).toBe("gateway type:thread,note,project project:app ");
    view.unmount();
  });

  it("names a file once: its folder beside the name, nothing for a root file", async () => {
    h.environments = h.envs.one;
    const view = render(<SearchView open cwd="/Users/me/app" recents={recents} {...props()} />);
    await search(view, "readme type:file");
    const [readme] = rows(view);
    expect(readme.textContent).toBe("README.md");
    await search(view, "gateway.ts type:file");
    expect(rows(view)[0].textContent).toBe("gateway.tssrc");
    view.unmount();
  });

  it("folds a file's matching lines into one row with +N more, and a name row opens at its first line", async () => {
    h.environments = h.envs.one;
    h.searchProject.mockImplementation((_env: string, options: { cwd: string }) =>
      Promise.resolve({
        matches: [
          { path: `${options.cwd}/src/app.ts`, relative: "src/app.ts", line: 7, column: 1, preview: "app.listen()" },
          { path: `${options.cwd}/src/app.ts`, relative: "src/app.ts", line: 3, column: 1, preview: "const app = make()" },
          { path: `${options.cwd}/src/gateway.ts`, relative: "src/gateway.ts", line: 9, column: 4, preview: "app gateway" },
          { path: `${options.cwd}/src/gateway.ts`, relative: "src/gateway.ts", line: 2, column: 2, preview: "app gate" },
        ],
        truncated: false,
      }),
    );
    const p = props();
    const view = render(<SearchView open cwd="/Users/me/app" recents={recents} {...p} />);
    await search(view, "app type:file");
    const content = rows(view).filter((row) => row.dataset.kind === "content");
    expect(content.map((row) => row.textContent)).toEqual([
      "const app = make()src/app.ts:3+1 more",
      "app gatesrc/gateway.ts:2+1 more",
    ]);
    await search(view, "gateway type:file");
    const [name] = rows(view);
    expect(name.dataset.kind).toBe("file");
    expect(name.textContent).toBe("gateway.tssrc:2+1 more");
    fireEvent.keyDown(view.container.querySelector("input") as HTMLInputElement, { key: "Enter" });
    expect(p.onOpenFile).toHaveBeenCalledWith("/Users/me/app/src/gateway.ts", { line: 2, column: 2 });
    view.unmount();
  });

  it("a bare type:note lists the notes, with no host search, spinner or footer", async () => {
    const view = render(<SearchView open cwd="/Users/me/app" recents={recents} initialQuery="type:note" {...props()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(kinds(view)).toEqual(["note"]);
    expect(rows(view)[0].textContent).toContain("Ship the fold");
    expect(rows(view)[0].textContent).toContain("Plan");
    expect(h.invokeOn.mock.calls.some(([, method]) => method === "search_sessions" || method === "notes_search")).toBe(false);
    expect(h.searchProject).not.toHaveBeenCalled();
    expect(view.container.querySelector('[data-slot="spinner"]')).toBeNull();
    expect(view.queryByLabelText("Hosts searched")).toBeNull();
    view.unmount();
  });

  it("a notes browse reads a host's notes once it comes online", async () => {
    h.statuses = new Map();
    const view = render(<SearchView open cwd="/Users/me/app" recents={recents} initialQuery="type:note" {...props()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(rows(view)).toHaveLength(0);
    h.statuses = new Map([["env_box", { transport: "open", fresh: true }]]);
    view.rerender(<SearchView open cwd="/Users/me/app" recents={recents} initialQuery="type:note" {...props()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(kinds(view)).toEqual(["note"]);
    view.unmount();
  });

  it("a bare type:file lists this project's recent files", async () => {
    h.recentFiles = ["/Users/me/app/README.md", "/Users/me/app/src/gateway.ts"];
    const view = render(<SearchView open cwd="/Users/me/app" recents={recents} {...props()} />);
    await search(view, "type:file");
    expect(rows(view).map((row) => row.textContent)).toEqual(["README.md", "gateway.tssrc"]);
    h.recentFiles = [];
    view.unmount();
  });

  it("a bare project: lists that project's threads", async () => {
    const view = render(<SearchView open cwd="/Users/me/app" recents={recents} {...props()} />);
    await search(view, "project:alpha");
    expect(kinds(view)).toEqual(["conversation"]);
    expect(rows(view)[0].textContent).toContain("Alpha thread");
    view.unmount();
  });

  it("a browse that finds nothing says so and offers to clear the filters", async () => {
    const view = render(<SearchView open cwd="/Users/me/app" recents={recents} {...props()} />);
    await search(view, "type:project host:box");
    expect(rows(view)).toHaveLength(0);
    expect(view.getByText("No results")).toBeTruthy();
    expect(view.getByText("Filters are narrowing this search")).toBeTruthy();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Clear filters" }));
    });
    expect((view.container.querySelector("input") as HTMLInputElement).value).toBe("");
    expect(view.queryByText("No results")).toBeNull();
    view.unmount();
  });

  it("says no host matched a host: name", async () => {
    const view = render(<SearchView open cwd="/Users/me/app" recents={recents} {...props()} />);
    await search(view, "gateway host:zzz");
    expect(rows(view)).toHaveLength(0);
    expect(view.getByText("No host named zzz")).toBeTruthy();
    view.unmount();
  });

  it("no results under a filter offers to clear the filters and keeps the words", async () => {
    const view = render(<SearchView open cwd="/Users/me/app" recents={recents} {...props()} />);
    await search(view, "nomatch type:project host:box");
    expect(view.getByText("No results")).toBeTruthy();
    expect(view.getByText("Filters are narrowing this search")).toBeTruthy();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Clear filters" }));
    });
    expect((view.container.querySelector("input") as HTMLInputElement).value).toBe("nomatch");
    view.unmount();
  });

  it("a notes hit's meta is the thread's title alone", async () => {
    h.invokeOn.mockImplementation((env: string, method: string) =>
      Promise.resolve({
        hits:
          method === "search_sessions" && env === "env_box"
            ? [{ sessionId: "s-box", seq: 2, role: "notes", snippet: "gateway plan", ts: 1, rank: -2 }]
            : [],
        truncated: false,
      }),
    );
    const view = render(<SearchView open cwd="/Users/me/app" recents={recents} {...props()} />);
    await search(view, "gateway type:thread");
    const note = rows(view).find((row) => row.textContent?.includes("gateway plan")) as HTMLElement;
    expect(note.textContent).toContain("Box thread");
    expect(note.textContent).not.toContain("Notes");
    view.unmount();
  });

  it("opens with the command's initial query in the field", async () => {
    const view = render(<SearchView open cwd="/Users/me/app" recents={recents} initialQuery="type:note" {...props()} />);
    const field = view.container.querySelector("input") as HTMLInputElement;
    expect(field.value).toBe("type:note ");
    expect(field.closest('[data-slot="input-group"]')).not.toBeNull();
    view.unmount();
  });

  it("keeps the last ticked box of a group, and Escape in the menu leaves search open", async () => {
    const p = props();
    const view = render(<SearchView open cwd="/Users/me/app" recents={recents} {...p} />);
    await search(view, "gateway type:thread");
    const menu = await openFilters(view);
    expect(menuItem(menu, "Threads").getAttribute("aria-disabled")).toBe("true");
    expect(menuItem(menu, "Files").getAttribute("aria-disabled")).not.toBe("true");
    await act(async () => {
      fireEvent.keyDown(menuItem(menu, "Files"), { key: "Escape" });
    });
    expect(p.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(view.container.querySelector("input") as HTMLInputElement, { key: "Escape" });
    expect(p.onClose).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
