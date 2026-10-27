// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FsEntry } from "../lib/fs";

const ROOT = "/repo";

const state = vi.hoisted(() => ({
  dirs: new Map<string, FsEntry[]>(),
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
vi.mock("../surfaces/chunks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../surfaces/chunks")>()),
  editorChunk: { preload: () => {} },
  mediaChunk: { preload: () => {} },
}));
vi.mock("./ConfirmDialog", () => ({ useConfirm: () => async () => true }));

import { FileTree } from "./FileTree";
import { renamePath } from "../lib/fs";

async function mount() {
  const onOpenFile = vi.fn();
  const view = render(<FileTree cwd={ROOT} onOpenFile={onOpenFile} />);
  await screen.findByText("README.md");
  return { ...view, onOpenFile };
}

/** A row of the open file menu, and whether it is disabled. */
async function row(name: string): Promise<{ el: HTMLElement; disabled: boolean }> {
  const menu = await screen.findByRole("menu", { name: "File actions" });
  const el = within(menu).getByText(name, { selector: "span" }).closest<HTMLElement>("[role='menuitem']")!;
  return { el, disabled: el.getAttribute("aria-disabled") === "true" };
}

describe("FileTree", () => {
  beforeEach(() => {
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
    expect((await row("Rename")).disabled).toBe(true);
    expect((await row("Delete")).disabled).toBe(true);
    expect((await row("Cut")).disabled).toBe(true);
    expect((await row("New File")).disabled).toBe(false);
    fireEvent.click((await row("Copy Path")).el);
    expect(writeText).toHaveBeenCalledWith(ROOT);
  });

  it("a row's context menu targets that row", async () => {
    await mount();
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /README\.md/ }));
    expect((await row("Rename")).disabled).toBe(false);
    expect((await row("Delete")).disabled).toBe(false);
    // Each verb with its glyph, and the file tree's real keys.
    expect((await row("Rename")).el.querySelector("svg")).toBeTruthy();
    expect((await row("Rename")).el.querySelector("kbd")?.textContent).toBe("F2");
  });

  describe("the rename field", () => {
    async function startRename(): Promise<HTMLInputElement> {
      await mount();
      fireEvent.contextMenu(screen.getByRole("treeitem", { name: /README\.md/ }));
      fireEvent.click((await row("Rename")).el);
      return (await screen.findByRole("textbox")) as HTMLInputElement;
    }
    beforeEach(() => {
      // jsdom has no layout: the field scrolls itself into view on open.
      Element.prototype.scrollIntoView = vi.fn();
      vi.mocked(renamePath).mockReset();
      vi.mocked(renamePath).mockResolvedValue(`${ROOT}/NOTES.md`);
    });

    it("opens focused with the name's stem selected", async () => {
      const input = await startRename();
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe("README.md");
      expect([input.selectionStart, input.selectionEnd]).toEqual([0, 6]);
    });

    it("commits on Enter", async () => {
      const input = await startRename();
      fireEvent.change(input, { target: { value: "NOTES.md" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await vi.waitFor(() => expect(renamePath).toHaveBeenCalledWith("local", `${ROOT}/README.md`, "NOTES.md"));
    });

    it("cancels on Escape", async () => {
      const input = await startRename();
      fireEvent.change(input, { target: { value: "NOTES.md" } });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(renamePath).not.toHaveBeenCalled();
    });

    it("commits on blur", async () => {
      const input = await startRename();
      fireEvent.change(input, { target: { value: "NOTES.md" } });
      fireEvent.blur(input);
      await vi.waitFor(() => expect(renamePath).toHaveBeenCalledWith("local", `${ROOT}/README.md`, "NOTES.md"));
    });
  });
});
