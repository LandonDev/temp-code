// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FsEntry } from "../lib/fs";
import type { ExplorerMenuItem } from "./ExplorerMenu";

const ROOT = "/repo";

const state = vi.hoisted(() => ({
  dirs: new Map<string, FsEntry[]>(),
  menu: null as { items: ExplorerMenuItem[]; onPick: (id: string) => void } | null,
}));

function entry(path: string, isDir = false): FsEntry {
  return { name: path.slice(path.lastIndexOf("/") + 1), path, isDir, ignored: false };
}

vi.mock("../lib/fs", () => ({
  basename: (path: string) => path.slice(path.lastIndexOf("/") + 1),
  listDir: async (_env: string, path: string) => state.dirs.get(path) ?? [],
  copyPath: vi.fn(),
  createPath: vi.fn(),
  deletePath: vi.fn(),
  movePath: vi.fn(),
  renamePath: vi.fn(),
  revealPath: vi.fn(),
}));
vi.mock("../lib/connection", () => ({ registry: { primary: () => ({ environmentId: "local" }) } }));
vi.mock("../lib/tcserver/projects", () => ({ environmentOfCwd: () => "local", hostOfCwd: () => "local" }));
vi.mock("../lib/editorConfig", () => ({ useEditorConfig: () => null }));
vi.mock("../lib/openInEditor", () => ({ editorLabelFor: () => null, openInEditor: vi.fn() }));
vi.mock("../lib/editorRename", () => ({ applyBeforeMove: vi.fn(), applyWillRename: vi.fn() }));
vi.mock("../lib/projectWatch", () => ({ watchCwd: () => () => {}, onFileEvent: () => () => {} }));
vi.mock("../surfaces/chunks", () => ({ editorChunk: { preload: () => {} }, mediaChunk: { preload: () => {} } }));
vi.mock("./ConfirmDialog", () => ({ useConfirm: () => async () => true }));
vi.mock("./ExplorerMenu", () => ({
  ExplorerMenu: (props: { items: ExplorerMenuItem[]; onPick: (id: string) => void }) => {
    state.menu = props;
    return <div role="menu" />;
  },
}));

import { FileTree } from "./FileTree";

async function mount() {
  const onOpenFile = vi.fn();
  const view = render(<FileTree cwd={ROOT} onOpenFile={onOpenFile} />);
  await screen.findByText("README.md");
  return { ...view, onOpenFile };
}

function item(id: string) {
  return state.menu?.items.find((it) => it.kind === "item" && it.id === id) as Extract<ExplorerMenuItem, { kind: "item" }>;
}

describe("FileTree", () => {
  beforeEach(() => {
    state.menu = null;
    state.dirs = new Map([
      [ROOT, [entry(`${ROOT}/src`, true), entry(`${ROOT}/README.md`)]],
      [`${ROOT}/src`, [entry(`${ROOT}/src/app.ts`)]],
    ]);
  });
  afterEach(cleanup);

  it("heads the tree with three named icon buttons and nothing else", async () => {
    const { container } = await mount();
    for (const name of ["New file", "New folder", "Collapse all"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    const header = screen.getByRole("button", { name: "New file" }).parentElement!;
    expect(header.querySelectorAll("button")).toHaveLength(3);
    expect(header.className).not.toContain("border-b");
    expect(container.querySelector("button[title]")).toBeNull();
  });

  it("opens with the root expanded and its children at the top level, no root row", async () => {
    await mount();
    const rows = screen.getAllByRole("treeitem");
    expect(rows.map((row) => row.dataset.path)).toEqual([`${ROOT}/src`, `${ROOT}/README.md`]);
    expect(rows.some((row) => row.dataset.path === ROOT)).toBe(false);
    expect(screen.getByRole("tree").getAttribute("aria-label")).toBe("repo files");
  });

  it("keeps the root's children after Collapse all and folds the folders", async () => {
    await mount();
    fireEvent.click(screen.getByRole("treeitem", { name: /src/ }));
    await screen.findByText("app.ts");
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryByText("app.ts")).toBeNull();
    expect(screen.getByText("README.md")).toBeTruthy();
  });

  it("marks the selected row with aria-current and the muted fill", async () => {
    const { onOpenFile } = await mount();
    const readme = screen.getByRole("treeitem", { name: /README\.md/ });
    fireEvent.click(readme);
    expect(onOpenFile).toHaveBeenCalledWith(`${ROOT}/README.md`);
    expect(readme.getAttribute("aria-current")).toBe("true");
    expect(readme.className).toContain("bg-muted");
    expect(screen.getByRole("treeitem", { name: /src/ }).getAttribute("aria-current")).toBeNull();
  });

  it("aims the background context menu at the root", async () => {
    await mount();
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    fireEvent.contextMenu(screen.getByRole("tree"));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(item("rename").disabled).toBe(true);
    expect(item("delete").disabled).toBe(true);
    expect(item("cut").disabled).toBe(true);
    expect(item("new-file").disabled).toBeFalsy();
    await act(async () => state.menu!.onPick("copy-path"));
    expect(writeText).toHaveBeenCalledWith(ROOT);
  });

  it("a row's context menu targets that row", async () => {
    await mount();
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /README\.md/ }));
    expect(item("rename").disabled).toBeFalsy();
    expect(item("delete").disabled).toBeFalsy();
  });
});
