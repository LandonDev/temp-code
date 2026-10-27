import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The registry runs on window timers; the node project has no window.
vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown; addEventListener?: unknown };
  g.addEventListener = () => {};
  g.window = globalThis;
});

type Range = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };

/** A Monaco text model with just what the registry calls: value, the
 *  alternative version id (undo returns to an earlier one), edits. */
class FakeModel {
  value: string;
  alt = 1;
  next = 2;
  history: { value: string; alt: number }[] = [];
  listeners = new Set<() => void>();
  uri = { toString: () => "file:///w/a.ts" };
  constructor(value: string) {
    this.value = value;
  }
  getValue() {
    return this.value;
  }
  getAlternativeVersionId() {
    return this.alt;
  }
  getLanguageId() {
    return "plaintext";
  }
  getPositionAt(offset: number) {
    const before = this.value.slice(0, offset).split("\n");
    return { lineNumber: before.length, column: before[before.length - 1].length + 1 };
  }
  offsetAt(line: number, column: number) {
    const lines = this.value.split("\n");
    let offset = 0;
    for (let i = 0; i < line - 1; i++) offset += lines[i].length + 1;
    return offset + column - 1;
  }
  set(value: string) {
    this.history.push({ value: this.value, alt: this.alt });
    this.value = value;
    this.alt = this.next++;
    for (const l of this.listeners) l();
  }
  pushEditOperations(_sel: unknown, ops: { range: Range; text: string }[]) {
    const [op] = ops;
    const start = this.offsetAt(op.range.startLineNumber, op.range.startColumn);
    const end = this.offsetAt(op.range.endLineNumber, op.range.endColumn);
    this.set(this.value.slice(0, start) + op.text + this.value.slice(end));
  }
  undo() {
    const last = this.history.pop()!;
    this.value = last.value;
    this.alt = last.alt;
    for (const l of this.listeners) l();
  }
  onDidChangeContent(cb: () => void) {
    this.listeners.add(cb);
    return { dispose: () => this.listeners.delete(cb) };
  }
  dispose() {}
}

const h = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  writes: [] as string[],
  model: null as unknown,
  fileEvent: null as null | ((e: { path: string; kind: string }) => void),
  autoSave: true,
}));

vi.mock("./monaco", () => ({
  languageForPath: () => "plaintext",
  monaco: {
    Range: class {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
    },
    Uri: { file: (p: string) => ({ toString: () => `file://${p}` }), parse: (s: string) => s },
    MarkerSeverity: { Error: 8 },
    editor: {
      getModel: () => null,
      createModel: (value: string) => {
        h.model = new FakeModel(value);
        return h.model;
      },
      onDidChangeMarkers: () => {},
      getModelMarkers: () => [],
    },
  },
}));
vi.mock("../../lib/fs", () => ({
  readTextFile: async (_host: string, path: string) => {
    const text = h.disk.get(path);
    if (text === undefined) throw new Error("ENOENT");
    return text;
  },
  writeTextFile: async (_host: string, path: string, text: string) => {
    h.writes.push(text);
    h.disk.set(path, text);
  },
  notifyGitChanged: () => {},
}));
vi.mock("../../lib/fileWatch", () => ({ syncWatchedMtime: async () => {}, watchFile: () => () => {} }));
vi.mock("../../lib/projectWatch", () => ({
  onFileEvent: (cb: (e: { path: string; kind: string }) => void) => {
    h.fileEvent = cb;
  },
  watchCwd: () => () => {},
}));
vi.mock("../../lib/settings", () => ({
  loadAutoSave: () => h.autoSave,
  loadFormatOnSave: () => ({ java: false, web: false }),
}));
vi.mock("../../lib/tcserver/projects", () => ({ hostOfCwd: () => "local" }));
vi.mock("../../lib/editorRename", () => ({ registerBeforeMove: () => {} }));

import { AUTOSAVE_MS, flushAll, isModelDirty, openFile, resolveConflict, saveNow, type OpenedFile } from "./models";

const PATH = "/w/a.ts";
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const edit = (text: string, line: number, to: string) => {
  const parts = text.split("\n");
  parts[line - 1] = to;
  return parts.join("\n");
};
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("the model registry and the disk race", () => {
  const base = lines(10);
  let opened: OpenedFile;
  let model: FakeModel;

  beforeEach(async () => {
    vi.useFakeTimers();
    h.disk.clear();
    h.writes.length = 0;
    h.autoSave = true;
    h.disk.set(PATH, base);
    opened = await openFile(PATH, "/w");
    model = h.model as FakeModel;
  });
  afterEach(() => {
    h.autoSave = false;
    opened.release();
    vi.useRealTimers();
  });

  /** An agent writes the file and the watcher says so. */
  const agentWrites = async (text: string) => {
    h.disk.set(PATH, text);
    h.fileEvent!({ path: PATH, kind: "changed" });
    await settle();
  };
  const autosave = async () => {
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    await settle();
  };

  it("merges an external change on other lines into the buffer while typing, washes it and writes both once", async () => {
    const washed: unknown[] = [];
    opened.onExternalChange((range) => washed.push(range));
    model.set(edit(base, 2, "mine"));
    await agentWrites(edit(base, 9, "theirs"));
    const both = edit(edit(base, 2, "mine"), 9, "theirs");
    expect(model.getValue()).toBe(both);
    expect(washed).toEqual([{ startLineNumber: 9, startColumn: 1, endLineNumber: 9, endColumn: 1 }]);
    expect(h.writes).toEqual([]);
    await autosave();
    expect(h.writes).toEqual([both]);
    expect(isModelDirty(PATH)).toBe(false);
    expect(opened.state.conflict).toBeNull();
  });

  it("writes nothing when the change is on the same line, and autosave and flushAll hold while the bar shows", async () => {
    model.set(edit(base, 4, "mine"));
    await agentWrites(edit(base, 4, "theirs"));
    expect(getState().conflict).toBe("external");
    await autosave();
    await flushAll();
    expect(h.writes).toEqual([]);
    expect(h.disk.get(PATH)).toBe(edit(base, 4, "theirs"));
    expect(model.getValue()).toBe(edit(base, 4, "mine"));
    expect(getState().pending).toBe(true);
  });

  it("raises the bar when the pre-write read finds the same line changed (no watch event yet)", async () => {
    model.set(edit(base, 4, "mine"));
    h.disk.set(PATH, edit(base, 4, "theirs"));
    await autosave();
    expect(h.writes).toEqual([]);
    expect(getState().conflict).toBe("external");
  });

  it("⌘S keeps mine and writes it over the disk; the bar goes", async () => {
    model.set(edit(base, 4, "mine"));
    await agentWrites(edit(base, 4, "theirs"));
    expect(await saveNow(PATH)).toBe(true);
    expect(h.writes).toEqual([edit(base, 4, "mine")]);
    expect(getState()).toEqual({ pending: false, conflict: null });
  });

  it("Reload takes the disk's text, clean; ⌘Z brings mine back and the next save writes it", async () => {
    model.set(edit(base, 4, "mine"));
    await agentWrites(edit(base, 4, "theirs"));
    expect(await resolveConflict(PATH, "reload")).toBe(true);
    expect(model.getValue()).toBe(edit(base, 4, "theirs"));
    expect(getState()).toEqual({ pending: false, conflict: null });
    expect(isModelDirty(PATH)).toBe(false);
    model.undo();
    expect(model.getValue()).toBe(edit(base, 4, "mine"));
    expect(isModelDirty(PATH)).toBe(true);
    await autosave();
    expect(h.writes).toEqual([edit(base, 4, "mine")]);
  });

  it("a clean buffer takes an external change as it always did", async () => {
    await agentWrites(edit(base, 4, "theirs"));
    expect(model.getValue()).toBe(edit(base, 4, "theirs"));
    expect(isModelDirty(PATH)).toBe(false);
    expect(h.writes).toEqual([]);
  });

  it("a deleted file's Restore writes the buffer back", async () => {
    model.set(edit(base, 2, "mine"));
    h.disk.delete(PATH);
    h.fileEvent!({ path: PATH, kind: "deleted" });
    expect(getState().conflict).toBe("deleted");
    await autosave();
    expect(h.writes).toEqual([]);
    expect(await resolveConflict(PATH, "keep")).toBe(true);
    expect(h.disk.get(PATH)).toBe(edit(base, 2, "mine"));
    expect(getState().conflict).toBeNull();
  });

  let current = { pending: false, conflict: null as string | null };
  beforeEach(() => {
    current = opened.state as typeof current;
    opened.onState((s) => {
      current = s as typeof current;
    });
  });
  const getState = () => current;
});
