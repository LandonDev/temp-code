// @vitest-environment jsdom
// A node-project file on jsdom: the dom project stubs CodeMirror, and this
// test needs the real editor under FileEditor's save path.
import "../test/domSetup";

// CodeMirror measures text ranges; jsdom has no layout.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";

const h = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  writes: [] as string[],
  watch: null as null | (() => void),
}));

vi.mock("../lib/fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/fs")>()),
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
  subscribeGitChanged: () => () => {},
}));
vi.mock("../lib/fileWatch", () => ({
  syncWatchedMtime: async () => {},
  watchFile: (_path: string, cb: () => void) => {
    h.watch = cb;
    return () => {};
  },
}));
vi.mock("../lib/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/settings")>()),
  loadAutoSave: () => false,
}));
vi.mock("../lib/format", () => ({ formatText: async () => null }));

import { flushEditor } from "../lib/editorFlush";
import { FileEditor } from "./FileEditor";

const PATH = "/w/notes.md";
const base = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const edit = (text: string, line: number, to: string) => {
  const parts = text.split("\n");
  parts[line - 1] = to;
  return parts.join("\n");
};

describe("the Markdown editor and the disk race", () => {
  beforeEach(() => {
    h.disk.clear();
    h.writes.length = 0;
    h.watch = null;
    h.disk.set(PATH, base);
  });
  afterEach(cleanup);

  const mount = async () => {
    const view = render(<FileEditor path={PATH} cwd="/w" environmentId="local" active onDirtyChange={() => {}} />);
    await waitFor(() => expect(view.container.querySelector(".cm-editor")).not.toBeNull());
    const cm = EditorView.findFromDOM(view.container.querySelector(".cm-editor") as HTMLElement)!;
    return { ...view, cm };
  };
  /** The person types: one line of the document becomes `to`. */
  const type = (cm: EditorView, line: number, to: string) => {
    const at = cm.state.doc.line(line);
    act(() => cm.dispatch({ changes: { from: at.from, to: at.to, insert: to } }));
  };
  const button = (container: HTMLElement, name: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === name) ?? null;

  it("merges a disk change on other lines and writes both in one write", async () => {
    const { cm, container } = await mount();
    type(cm, 2, "mine");
    h.disk.set(PATH, edit(base, 9, "theirs"));
    let ok = false;
    await act(async () => {
      ok = await flushEditor(PATH);
    });
    const both = edit(edit(base, 2, "mine"), 9, "theirs");
    expect(ok).toBe(true);
    expect(h.writes).toEqual([both]);
    expect(cm.state.doc.toString()).toBe(both);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows the bar for the same line and writes nothing; Keep mine writes the buffer and the bar goes", async () => {
    const { cm, container } = await mount();
    type(cm, 4, "mine");
    h.disk.set(PATH, edit(base, 4, "theirs"));
    let ok = true;
    await act(async () => {
      ok = await flushEditor(PATH);
    });
    expect(ok).toBe(false);
    expect(h.writes).toEqual([]);
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("Changed on disk where you were editing");
    expect(button(container, "Reload")).not.toBeNull();
    // Another flush while the bar shows writes nothing either.
    await act(async () => {
      ok = await flushEditor(PATH);
    });
    expect(h.writes).toEqual([]);
    await act(async () => {
      fireEvent.click(button(container, "Keep mine")!);
    });
    await waitFor(() => expect(h.writes).toEqual([edit(base, 4, "mine")]));
    await waitFor(() => expect(container.querySelector('[role="alert"]')).toBeNull());
  });

  it("Reload makes the document the disk's text and the bar goes", async () => {
    const { cm, container } = await mount();
    type(cm, 4, "mine");
    h.disk.set(PATH, edit(base, 4, "theirs"));
    await act(async () => {
      await flushEditor(PATH);
    });
    await act(async () => {
      fireEvent.click(button(container, "Reload")!);
    });
    expect(cm.state.doc.toString()).toBe(edit(base, 4, "theirs"));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(h.writes).toEqual([]);
  });

  it("a watch event under unsaved edits on other lines merges without writing", async () => {
    const { cm } = await mount();
    type(cm, 2, "mine");
    h.disk.set(PATH, edit(base, 9, "theirs"));
    await act(async () => {
      h.watch!();
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(cm.state.doc.toString()).toBe(edit(edit(base, 2, "mine"), 9, "theirs"));
    expect(h.writes).toEqual([]);
  });
});
