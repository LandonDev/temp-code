import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { DiffSurface } from "./DiffSurface";

const h = vi.hoisted(() => ({
  changes: [] as { modifiedStartLineNumber: number; modifiedEndLineNumber: number; originalStartLineNumber: number; originalEndLineNumber: number }[],
  position: 1,
  diffUpdate: () => {},
  cursorUpdate: () => {},
  setPosition: vi.fn(),
  reveal: vi.fn(),
  focus: vi.fn(),
  request: vi.fn(async () => "base"),
  disposeDiff: vi.fn(),
  disposeCursor: vi.fn(),
  release: vi.fn(),
}));
vi.mock("../../lib/editorFlush", () => ({ registerEditorFlusher: () => () => {} }));
vi.mock("../../lib/fs", () => ({ gitFileDiff: vi.fn() }));
vi.mock("../../lib/connection", () => ({ registry: { linkOf: () => ({ request: h.request }) } }));
vi.mock("../../lib/tcserver/projects", () => ({ projectForCwd: () => ({ id: "project", environmentId: "host" }), hostOfCwd: () => "host" }));
vi.mock("./keys", () => ({ trackEditor: () => () => {} }));
vi.mock("./lsp/idea", () => ({ ensureForModel: vi.fn() }));
vi.mock("./lsp/providers", () => ({ registerProviders: vi.fn() }));
vi.mock("./theme", () => ({ monacoReady: async () => {} }));
vi.mock("./models", () => ({
  openFile: async () => ({ model: {}, state: { pending: false, conflict: null }, onState: () => () => {}, release: h.release }),
  resolveConflict: vi.fn(), saveExplicit: vi.fn(), saveNow: vi.fn(),
}));
vi.mock("./monaco", () => ({
  EDITOR_OPTIONS: {}, editorFontFamily: () => "mono", followEditorFont: () => () => {}, languageForPath: () => "text",
  monaco: {
    KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 1 },
    editor: {
      createModel: () => ({ dispose: vi.fn() }),
      createDiffEditor: () => ({
        setModel: vi.fn(), dispose: vi.fn(), getLineChanges: () => h.changes,
        onDidUpdateDiff: (cb: () => void) => { h.diffUpdate = cb; return { dispose: h.disposeDiff }; },
        getModifiedEditor: () => ({
          addCommand: vi.fn(), getPosition: () => ({ lineNumber: h.position }),
          setPosition: h.setPosition, revealLineInCenter: h.reveal, focus: h.focus,
          onDidChangeCursorPosition: (cb: () => void) => { h.cursorUpdate = cb; return { dispose: h.disposeCursor }; },
        }),
      }),
    },
  },
}));

const change = (start: number, end: number, originalStart: number, originalEnd: number) => ({
  modifiedStartLineNumber: start, modifiedEndLineNumber: end, originalStartLineNumber: originalStart, originalEndLineNumber: originalEnd,
});

describe("Monaco review header", () => {
  beforeEach(() => { vi.clearAllMocks(); h.changes = []; h.position = 1; });
  afterEach(cleanup);

  it("shows the folder and base review counts, steps through changes and follows the caret", async () => {
    h.changes = [change(2, 3, 2, 2), change(9, 0, 9, 10), change(15, 15, 14, 0)];
    const { container, getByRole } = render(<DiffSurface path="/repo/src/file.ts" cwd="/repo" base="review-base" />);
    // The caret sits above the first change: none is current yet, and Next reaches the first.
    await waitFor(() => expect(container.textContent).toContain("0/3"));
    expect(container.textContent).toContain("src");
    expect(container.textContent).toContain("+3");
    expect(container.textContent).toContain("−3");
    expect(h.request).toHaveBeenCalledWith("project.show", { projectId: "project", path: "src/file.ts", ref: "review-base" });
    expect(getByRole<HTMLButtonElement>("button", { name: "Previous change" }).disabled).toBe(true);
    fireEvent.click(getByRole("button", { name: "Next change" }));
    expect(h.setPosition).toHaveBeenCalledWith({ lineNumber: 2, column: 1 });
    expect(container.textContent).toContain("1/3");
    fireEvent.click(getByRole("button", { name: "Next change" }));
    expect(h.setPosition).toHaveBeenCalledWith({ lineNumber: 9, column: 1 });
    expect(h.reveal).toHaveBeenCalledWith(9);
    expect(h.focus).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("2/3");
    act(() => { h.position = 15; h.cursorUpdate(); });
    expect(container.textContent).toContain("3/3");
    expect(getByRole<HTMLButtonElement>("button", { name: "Next change" }).disabled).toBe(true);
    act(() => { h.changes = []; h.diffUpdate(); });
    expect(container.textContent).toContain("0/0");
    expect(getByRole<HTMLButtonElement>("button", { name: "Previous change" }).disabled).toBe(true);
  });

  it("anchors a deletion before the first line and disposes navigation listeners", async () => {
    h.changes = [change(0, 0, 1, 2), change(5, 5, 5, 5)];
    const { container, getByRole, unmount } = render(<DiffSurface path="/repo/file.ts" cwd="/repo" />);
    await waitFor(() => expect(container.textContent).toContain("1/2"));
    fireEvent.click(getByRole("button", { name: "Next change" }));
    fireEvent.click(getByRole("button", { name: "Previous change" }));
    expect(h.setPosition).toHaveBeenLastCalledWith({ lineNumber: 1, column: 1 });
    unmount();
    expect(h.disposeDiff).toHaveBeenCalledOnce();
    expect(h.disposeCursor).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledOnce();
  });
});
