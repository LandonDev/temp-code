import { beforeEach, describe, expect, it, vi } from "vitest";

const { pushListeners, request } = vi.hoisted(() => ({
  pushListeners: [] as ((push: unknown) => void)[],
  request: vi.fn((method: string, params: { sessionId: string; text?: string }) => {
    if (method === "session.notes.get") return Promise.resolve({ text: "## Goal\n\nShip.\n", updatedAt: 10, path: "/p/notes.md" });
    if (method === "session.notes.set") return Promise.resolve({ text: params.text, updatedAt: 20, path: "/p/notes.md" });
    return Promise.resolve(null);
  }),
}));

vi.mock("./connection", () => {
  const link = {
    environmentId: "local",
    request,
    onOpen: () => () => {},
    onPush: (l: (push: unknown) => void) => {
      pushListeners.push(l);
      return () => {};
    },
  };
  return {
    registry: {
      linkOf: () => link,
      onLink: (listener: (link: unknown, event: string) => void) => {
        listener(link, "added");
        return () => {};
      },
    },
  };
});

import { applyNotesPush, loadNotes, notesOf, resetNotesStore, saveNotes, subscribeNotes } from "./threadNotes";

const push = (p: unknown): void => {
  for (const l of pushListeners) l(p);
};

beforeEach(() => {
  resetNotesStore();
  request.mockClear();
});

describe("the renderer's notes store", () => {
  it("fetches once per thread and caches the answer", async () => {
    expect(notesOf("s1")).toBeUndefined();
    const a = loadNotes("local", "s1");
    const b = loadNotes("local", "s1");
    expect(await a).toEqual({ text: "## Goal\n\nShip.\n", updatedAt: 10, path: "/p/notes.md" });
    await b;
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("session.notes.get", { sessionId: "s1" });
    expect(notesOf("s1")?.updatedAt).toBe(10);
  });

  it("a notes push from the host updates the copy and wakes subscribers", async () => {
    await loadNotes("local", "s1");
    const seen: number[] = [];
    const off = subscribeNotes("s1", () => seen.push(notesOf("s1")?.updatedAt ?? -1));
    push({ push: "notes", sessionId: "s1", doc: { text: "## Goal\n\nShip it.\n", updatedAt: 11, path: "/p/notes.md" } });
    expect(notesOf("s1")?.text).toBe("## Goal\n\nShip it.\n");
    expect(seen).toEqual([11]);
    // The same doc again is no change.
    push({ push: "notes", sessionId: "s1", doc: { text: "## Goal\n\nShip it.\n", updatedAt: 11, path: "/p/notes.md" } });
    expect(seen).toEqual([11]);
    // Another thread's push leaves this subscriber alone.
    applyNotesPush("s2", { text: "x", updatedAt: 1, path: null });
    expect(seen).toEqual([11]);
    off();
  });

  it("saving sends the whole text and keeps what the host answered", async () => {
    const doc = await saveNotes("local", "s1", "## State\n\n- half\n");
    expect(request).toHaveBeenCalledWith("session.notes.set", { sessionId: "s1", text: "## State\n\n- half\n" });
    expect(doc.updatedAt).toBe(20);
    expect(notesOf("s1")?.text).toBe("## State\n\n- half\n");
  });
});
