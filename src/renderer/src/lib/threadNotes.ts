import { useSyncExternalStore } from "react";
import type { ThreadNotesDoc } from "@shared/contract";
import { registry } from "./connection";

/**
 * The renderer's copy of each thread's notes (src/main/server/threadNotes.ts):
 * fetched once per thread on first use, then kept current by the `notes`
 * push every host sends when the harness, the person or the file changed
 * them. The thread's own host answers, so a box thread's notes come over
 * its link like the rest of its content.
 */

export type { ThreadNotesDoc };

type Listener = () => void;

const docs = new Map<string, ThreadNotesDoc>();
const pending = new Map<string, Promise<ThreadNotesDoc | null>>();
const listeners = new Map<string, Set<Listener>>();
const anyListeners = new Set<Listener>();

const EMPTY: ThreadNotesDoc = { text: "", updatedAt: null, path: null };

function emit(sessionId: string): void {
  for (const l of listeners.get(sessionId) ?? []) l();
  for (const l of anyListeners) l();
}

function put(sessionId: string, doc: ThreadNotesDoc): void {
  const prev = docs.get(sessionId);
  if (prev && prev.text === doc.text && prev.updatedAt === doc.updatedAt && prev.path === doc.path) return;
  docs.set(sessionId, doc);
  emit(sessionId);
}

/** What is known now; undefined until the first fetch answered. */
export function notesOf(sessionId: string): ThreadNotesDoc | undefined {
  return docs.get(sessionId);
}

/** Fetch (or re-fetch) a thread's notes from its host. */
export async function loadNotes(environmentId: string, sessionId: string): Promise<ThreadNotesDoc | null> {
  const inFlight = pending.get(sessionId);
  if (inFlight) return inFlight;
  const p = (async () => {
    try {
      const doc = (await registry.linkOf(environmentId).request("session.notes.get", { sessionId })) as ThreadNotesDoc;
      put(sessionId, doc);
      return doc;
    } catch {
      return null;
    } finally {
      pending.delete(sessionId);
    }
  })();
  pending.set(sessionId, p);
  return p;
}

/** The person's edit: the host writes the file, mirrors it and pushes. */
export async function saveNotes(environmentId: string, sessionId: string, text: string): Promise<ThreadNotesDoc> {
  const doc = (await registry.linkOf(environmentId).request("session.notes.set", { sessionId, text })) as ThreadNotesDoc;
  put(sessionId, doc);
  return doc;
}

/** Test seam: a push landed (what registry.onLink wires below). */
export function applyNotesPush(sessionId: string, doc: ThreadNotesDoc): void {
  put(sessionId, doc);
}

export function subscribeNotes(sessionId: string, listener: Listener): () => void {
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(sessionId);
  };
}

export function subscribeAnyNotes(listener: Listener): () => void {
  anyListeners.add(listener);
  return () => anyListeners.delete(listener);
}

/** A thread's notes, live. Fetches on first use; `undefined` until then. */
export function useThreadNotes(environmentId: string | null | undefined, sessionId: string | null | undefined): ThreadNotesDoc | undefined {
  const doc = useSyncExternalStore(
    (cb) => (sessionId ? subscribeNotes(sessionId, cb) : () => {}),
    () => (sessionId ? docs.get(sessionId) : undefined),
  );
  if (environmentId && sessionId && doc === undefined && !pending.has(sessionId)) void loadNotes(environmentId, sessionId);
  return doc;
}

/** Test seam: forget everything (a module-level store). */
export function resetNotesStore(): void {
  docs.clear();
  pending.clear();
}

export const EMPTY_NOTES_DOC = EMPTY;

registry.onLink((link, event) => {
  if (event === "removed") return;
  link.onPush((push) => {
    if (push.push === "notes") put(push.sessionId, push.doc);
  });
});
