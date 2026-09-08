import { invoke, windowSlot } from "./native";
import type { HarnessId, RuntimeMode, Session } from "./session";
import { normalizeProjectPath, sameProjectPath } from "./recents";
import * as commands from "./tcserver/commands";
import { sessionFromMeta, sessionStore } from "./tcserver/store";
import type { SessionMeta } from "./tcserver/types";

/**
 * Session history over the server's session list. The server owns every
 * transcript; this module keeps the API the sidebar, search, and project
 * views already call. Only the workspace snapshot (tab layout) still
 * lives in the app's own SQLite.
 */

export type SessionSummary = {
  id: string;
  cwd: string;
  harness: HarnessId;
  model: string;
  runtimeMode: RuntimeMode;
  title: string;
  providerSessionId?: string;
  branch?: string;
  repo?: string;
  additions?: number;
  deletions?: number;
  createdAt: number;
  updatedAt: number;
  archived?: boolean;
  pinned?: boolean;
};

/** Only real chats belong in project history — blank tabs stay ephemeral. */
export function shouldPersistSession(session: Session): boolean {
  return (
    session.cwd !== "~" && session.blocks.some((block) => block.role === "user")
  );
}

export function summaryFromMeta(meta: SessionMeta): SessionSummary {
  const view = sessionStore.get(meta.id) ?? sessionFromMeta(meta);
  return {
    id: meta.id,
    cwd: normalizeProjectPath(meta.cwd),
    harness: view.harness,
    model: view.model,
    runtimeMode: view.runtimeMode,
    title: meta.title,
    ...(meta.nativeId ? { providerSessionId: meta.nativeId } : {}),
    additions: 0,
    deletions: 0,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    archived: meta.archived || undefined,
    pinned: meta.pinned || undefined,
  };
}

/** Server sessions in a project, newest first. */
export async function listSessionsByProject(
  cwd: string,
): Promise<SessionSummary[]> {
  if (!cwd || cwd === "~") return [];
  await sessionStore.ready();
  return sessionStore
    .metas()
    .filter((meta) => !meta.parentId && sameProjectPath(meta.cwd, cwd))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(summaryFromMeta);
}

/** Re-run the sidebar's list whenever the server's session set changes. */
export function subscribeSessionHistory(listener: () => void): () => void {
  return sessionStore.onMetaChange(listener);
}

export type SessionSearchHit = {
  kind: "conversation" | "message";
  sessionId: string;
  cwd: string;
  harness: string;
  title: string;
  updatedAt: number;
  blockId?: string;
  /** Event log row the hit came from; the transcript scrolls to it. */
  seq?: number;
  role?: string;
  preview: string;
};

export type SessionSearchResult = {
  hits: SessionSearchHit[];
  truncated: boolean;
};

const SEARCH_LIMIT = 200;

type ServerSearchHit = {
  sessionId: string;
  seq: number;
  role: "user" | "assistant";
  snippet: string;
  ts: number;
};

/** Titles always; message bodies from the loaded transcripts, then the
 *  server's event-log search (`session.search`) for every thread this window
 *  never opened. Server rows for a block already matched in memory dedupe on
 *  `sessionId:seq`. */
export async function searchSessions(options: {
  query: string;
  cwd?: string;
  includeArchived?: boolean;
}): Promise<SessionSearchResult> {
  const query = options.query.trim().toLowerCase();
  if (!query) return { hits: [], truncated: false };
  await sessionStore.ready();
  const hits: SessionSearchHit[] = [];
  const seen = new Set<string>();
  const metas = sessionStore
    .metas()
    .filter((meta) => !meta.parentId)
    .filter((meta) => options.includeArchived || !meta.archived)
    .filter(
      (meta) =>
        !options.cwd || options.cwd === "~" || sameProjectPath(meta.cwd, options.cwd),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const baseOf = (meta: SessionMeta) => ({
    sessionId: meta.id,
    cwd: normalizeProjectPath(meta.cwd),
    harness: meta.provider,
    title: meta.title,
    updatedAt: meta.updatedAt,
  });
  for (const meta of metas) {
    if (hits.length >= SEARCH_LIMIT) return { hits, truncated: true };
    const base = baseOf(meta);
    if (meta.title.toLowerCase().includes(query)) {
      hits.push({ kind: "conversation", ...base, preview: meta.title });
    }
    const view = sessionStore.get(meta.id);
    for (const block of view?.blocks ?? []) {
      if (block.role !== "user" && block.role !== "assistant") continue;
      const at = block.text.toLowerCase().indexOf(query);
      if (at < 0) continue;
      if (block.seq !== undefined) seen.add(`${meta.id}:${block.seq}`);
      hits.push({
        kind: "message",
        ...base,
        blockId: block.id,
        seq: block.seq,
        role: block.role,
        preview: block.text.slice(Math.max(0, at - 60), at + 120).trim(),
      });
      if (hits.length >= SEARCH_LIMIT) return { hits, truncated: true };
    }
  }
  const byId = new Map(metas.map((meta) => [meta.id, meta]));
  const remote = await invoke<{ hits: ServerSearchHit[]; truncated: boolean }>(
    "search_sessions",
    { query: options.query.trim(), limit: SEARCH_LIMIT },
  ).catch(() => ({ hits: [], truncated: false }));
  for (const row of remote.hits) {
    const meta = byId.get(row.sessionId);
    if (!meta) continue;
    // A loaded transcript was searched block by block above; its rows add
    // nothing (a stream's final row would only repeat its block).
    if (sessionStore.get(meta.id)?.blocks.length) continue;
    const key = `${meta.id}:${row.seq}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({
      kind: "message",
      ...baseOf(meta),
      seq: row.seq,
      role: row.role,
      preview: row.snippet,
    });
    if (hits.length >= SEARCH_LIMIT) return { hits, truncated: true };
  }
  return { hits, truncated: remote.truncated };
}

/** The session as the server's meta describes it, transcript not fetched
 *  (blocks empty until `sessionStore.ensureLoaded`). Drafts come back whole. */
export async function peekSession(sessionId: string): Promise<Session | null> {
  await sessionStore.ready();
  return sessionStore.get(sessionId) ?? null;
}

/** The folded session, fetched from the server on first ask. */
export async function getSession(sessionId: string): Promise<Session | null> {
  await sessionStore.ready();
  if (sessionStore.isDraft(sessionId)) return sessionStore.get(sessionId) ?? null;
  await sessionStore.ensureLoaded(sessionId);
  return sessionStore.get(sessionId) ?? null;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await commands.remove(sessionId);
}

export async function setSessionArchived(
  sessionId: string,
  archived: boolean,
): Promise<void> {
  await commands.archive(sessionId, archived);
}

export async function setSessionPinned(
  sessionId: string,
  pinned: boolean,
): Promise<void> {
  await commands.pin(sessionId, pinned);
}

/**
 * `workspace_set_snapshot` runs off the main thread, so two saves could
 * otherwise finish out of order and keep an older layout.
 */
let workspaceWrite: Promise<unknown> = Promise.resolve();

export async function saveWorkspaceSnapshot(snapshot: unknown): Promise<void> {
  const run = workspaceWrite
    .catch(() => undefined)
    .then(() => invoke("workspace_set_snapshot", { snapshot, window: windowSlot() }));
  workspaceWrite = run;
  await run;
}

export async function loadWorkspaceSnapshot(): Promise<unknown | null> {
  const raw = await invoke<unknown | null>("workspace_get_snapshot", { window: windowSlot() });
  return raw ?? null;
}
