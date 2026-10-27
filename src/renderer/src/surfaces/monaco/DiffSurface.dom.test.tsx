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
  text: "one\nTWO\nthree\n",
  originalText: "base",
  pushEdit: vi.fn(),
  setOriginal: vi.fn(),
  gitFileDiff: vi.fn(async () => ({ original: "one\ntwo\nthree\n", binary: false, tooLarge: false })),
  stage: vi.fn(async () => {}),
  revertChunkText: vi.fn((_o: string, _c: string, _p: number): string | null => "one\ntwo\nthree\n"),
  // Nothing to stage once the index has the text.
  stageChunkText: vi.fn((o: string, c: string, _p: number): string | null => (o === c ? null : c)),
}));
vi.mock("../../lib/editorFlush", () => ({ registerEditorFlusher: () => () => {} }));
vi.mock("../../lib/fs", () => ({ gitFileDiff: h.gitFileDiff, gitStageContents: h.stage, notifyGitChanged: vi.fn() }));
vi.mock("../editorGit", () => ({ revertChunkText: h.revertChunkText, stageChunkText: h.stageChunkText }));
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
      EndOfLinePreference: { LF: 1 },
      createModel: () => ({ dispose: vi.fn(), getValue: () => h.originalText, setValue: h.setOriginal }),
      createDiffEditor: () => ({
        setModel: vi.fn(), dispose: vi.fn(), getLineChanges: () => h.changes,
        onDidUpdateDiff: (cb: () => void) => { h.diffUpdate = cb; return { dispose: h.disposeDiff }; },
        getModifiedEditor: () => ({
          addCommand: vi.fn(), getPosition: () => ({ lineNumber: h.position }),
          setPosition: h.setPosition, revealLineInCenter: h.reveal, focus: h.focus,
          getModel: () => ({ getValue: () => h.text, pushStackElement: vi.fn(), pushEditOperations: h.pushEdit }),
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
  beforeEach(() => { vi.clearAllMocks(); h.changes = []; h.position = 1; h.text = "one\nTWO\nthree\n"; h.originalText = "base"; });
  afterEach(cleanup);

  it("shows the folder and base review counts, steps through changes and follows the caret", async () => {
    h.changes = [change(2, 3, 2, 2), change(9, 0, 9, 10), change(15, 15, 14, 0)];
    const { container, getByRole } = render(<DiffSurface path="/repo/src/file.ts" cwd="/repo" base="review-base" />);
    // The tab opens on the first change.
    await waitFor(() => expect(container.textContent).toContain("1/3"));
    expect(h.setPosition).toHaveBeenCalledWith({ lineNumber: 2, column: 1 });
    expect(h.reveal).toHaveBeenCalledWith(2);
    expect(container.textContent).toContain("src");
    expect(container.textContent).toContain("+3");
    expect(container.textContent).toContain("−3");
    expect(h.request).toHaveBeenCalledWith("project.show", { projectId: "project", path: "src/file.ts", ref: "review-base" });
    expect(getByRole<HTMLButtonElement>("button", { name: "Previous change" }).disabled).toBe(true);
    fireEvent.click(getByRole("button", { name: "Next change" }));
    expect(h.setPosition).toHaveBeenCalledWith({ lineNumber: 9, column: 1 });
    expect(h.reveal).toHaveBeenCalledWith(9);
    expect(h.focus).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("2/3");
    // Moved above the first change by the person: none is current, and Next reaches the first.
    act(() => { h.position = 1; h.cursorUpdate(); });
    expect(container.textContent).toContain("0/3");
    act(() => { h.position = 9; h.cursorUpdate(); });
    act(() => { h.position = 15; h.cursorUpdate(); });
    expect(container.textContent).toContain("3/3");
    expect(getByRole<HTMLButtonElement>("button", { name: "Next change" }).disabled).toBe(true);
    act(() => { h.changes = []; h.diffUpdate(); });
    expect(container.textContent).toContain("0/0");
    expect(getByRole<HTMLButtonElement>("button", { name: "Previous change" }).disabled).toBe(true);
  });

  it("a review against a ref offers Revert but no Stage", async () => {
    h.changes = [change(2, 2, 2, 2)];
    const { getByRole, queryByRole } = render(<DiffSurface path="/repo/src/file.ts" cwd="/repo" base="review-base" />);
    await waitFor(() => expect(getByRole<HTMLButtonElement>("button", { name: "Revert change" }).disabled).toBe(false));
    expect(queryByRole("button", { name: "Stage change" })).toBeNull();
  });

  it("Revert puts the change back as one edit over just the span that changed", async () => {
    h.changes = [change(2, 2, 2, 2)];
    h.originalText = "one\ntwo\nthree\n";
    const { getByRole } = render(<DiffSurface path="/repo/src/file.ts" cwd="/repo" />);
    await waitFor(() => expect(getByRole<HTMLButtonElement>("button", { name: "Revert change" }).disabled).toBe(false));
    fireEvent.click(getByRole("button", { name: "Revert change" }));
    await waitFor(() => expect(h.pushEdit).toHaveBeenCalledOnce());
    // The change starts at line 2: offset 4 of the LF text.
    expect(h.revertChunkText).toHaveBeenCalledWith("one\ntwo\nthree\n", "one\nTWO\nthree\n", 4);
    expect(h.pushEdit).toHaveBeenCalledWith(null, [{ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 4 }, text: "two" }], expect.any(Function));
  });

  it("Stage builds on the index and stages the change at the caret, then is off for it", async () => {
    h.changes = [change(2, 2, 2, 2)];
    const { getByRole } = render(<DiffSurface path="/repo/src/file.ts" cwd="/repo" />);
    const stage = () => getByRole<HTMLButtonElement>("button", { name: "Stage change" });
    await waitFor(() => expect(stage().disabled).toBe(false));
    fireEvent.click(stage());
    await waitFor(() => expect(h.stage).toHaveBeenCalledWith("host", "/repo", "src/file.ts", "one\nTWO\nthree\n"));
    expect(h.stageChunkText).toHaveBeenCalledWith("one\ntwo\nthree\n", "one\nTWO\nthree\n", 4);
    // The index now has the change: nothing is left to stage there.
    await waitFor(() => expect(stage().disabled).toBe(true));
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
