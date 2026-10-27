import type { LaunchMirrorSnapshot, MirrorCursor, MirrorSummary, MirrorWrite } from "@server/shared/launchMirror";
import { isWebMode, readLaunchMirror, writeLaunchMirror } from "../native";
import { registry, savedEnvironment } from "../connection";
import { sessionStore } from "./store";
import { workspaceStore } from "./workspaces";
import type { ProjectMeta, SessionMeta, WorkspaceMeta } from "./types";

/**
 * The launch mirror on the renderer side (CLAUDE.md "Launch: the rail
 * paints from the launch mirror"). At boot `hydrateFromLaunchMirror` reads
 * what every host last showed through preload, synchronously, registers
 * the saved hosts so the rail has their sections, and seeds the session and
 * workspace stores, all before the first render and before any socket.
 * Then `installLaunchMirrorWriter` keeps the mirror current: after every
 * meta or catalog change it diffs each listed host's rows against what it
 * last wrote and sends the difference, coalesced, to the main process.
 */

/** Fields a meta carries only while a turn runs; the mirror leaves them out. */
const TRANSIENT: readonly (keyof SessionMeta)[] = ["activity", "activityKind", "background"];

export const MIRROR_WRITE_DELAY_MS = 750;

/** A meta as the mirror keeps it: the same object minus its transient fields. */
export function summarize(meta: SessionMeta): MirrorSummary {
  const out = { ...meta } as Record<string, unknown>;
  for (const key of TRANSIENT) delete out[key];
  return out as unknown as MirrorSummary;
}

/** Paint from the mirror. Returns what was read, or null when there is
 *  nothing to paint from (the /ui page, a first launch, a test). */
export function hydrateFromLaunchMirror(): LaunchMirrorSnapshot | null {
  if (isWebMode() || typeof window === "undefined") return null;
  let snapshot: LaunchMirrorSnapshot | null = null;
  try {
    snapshot = readLaunchMirror();
  } catch (err) {
    console.error("[launch-mirror] read failed", err);
    return null;
  }
  if (!snapshot) return null;
  // The saved hosts first, so the rail groups their rows under their own
  // sections from the first frame; loadSavedEnvironments confirms them later.
  for (const env of snapshot.environments) registry.add(savedEnvironment(env));
  sessionStore.hydrate(snapshot.hosts);
  workspaceStore.hydrate(snapshot.hosts);
  return snapshot;
}

export type WriterSessionSource = {
  onMetaChange(listener: () => void): () => void;
  metas(): SessionMeta[];
  cursorOf(environmentId: string): MirrorCursor | null;
  listedEnvironmentIds(): string[];
};
export type WriterCatalogSource = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): { workspaces: readonly WorkspaceMeta[]; projects: readonly ProjectMeta[] };
};
export type WriterDeps = {
  sessions: WriterSessionSource;
  catalog: WriterCatalogSource;
  write(write: MirrorWrite): void;
  delayMs?: number;
  /** The document whose `visibilitychange` flushes a pending write at once. */
  doc?: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState"> | null;
};

type HostState = {
  /** The metas last written, by id, as the objects they were: identity is the diff. */
  written: Map<string, SessionMeta>;
  workspaces: readonly WorkspaceMeta[] | null;
  projects: readonly ProjectMeta[] | null;
  cursor: MirrorCursor | null;
};

/**
 * Keep the mirror current. Only a host whose list has landed this boot is
 * written (a host still painted from the mirror would be rewritten from
 * itself); its first write is `full`, every later one the rows whose meta
 * object changed and the ids that left. Pending writes flush after a quiet
 * `delayMs`, or at once when the page hides.
 */
export function installLaunchMirrorWriter(deps: WriterDeps): () => void {
  const delay = deps.delayMs ?? MIRROR_WRITE_DELAY_MS;
  const hosts = new Map<string, HostState>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;

  const flush = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    dirty = false;
    const listed = new Set(deps.sessions.listedEnvironmentIds());
    if (listed.size === 0) return;
    const byHost = new Map<string, Map<string, SessionMeta>>();
    for (const meta of deps.sessions.metas()) {
      if (!listed.has(meta.environmentId)) continue;
      let rows = byHost.get(meta.environmentId);
      if (!rows) byHost.set(meta.environmentId, (rows = new Map()));
      rows.set(meta.id, meta);
    }
    const catalog = deps.catalog.getSnapshot();
    for (const environmentId of listed) {
      const current = byHost.get(environmentId) ?? new Map<string, SessionMeta>();
      let state = hosts.get(environmentId);
      const first = !state;
      if (!state) hosts.set(environmentId, (state = { written: new Map(), workspaces: null, projects: null, cursor: null }));
      const write: MirrorWrite = { environmentId };
      const upserts: MirrorSummary[] = [];
      for (const [id, meta] of current) if (state.written.get(id) !== meta) upserts.push(summarize(meta));
      const removed: string[] = [];
      for (const id of state.written.keys()) if (!current.has(id)) removed.push(id);
      if (first) write.full = true;
      if (upserts.length > 0) write.upserts = upserts;
      if (removed.length > 0) write.removed = removed;
      const cursor = deps.sessions.cursorOf(environmentId);
      if (first || cursor?.seq !== state.cursor?.seq || cursor?.generation !== state.cursor?.generation) {
        write.cursor = cursor;
      }
      const workspaces = catalog.workspaces.filter((w) => w.environmentId === environmentId);
      const projects = catalog.projects.filter((p) => p.environmentId === environmentId);
      if (first || !sameRows(workspaces, state.workspaces)) write.workspaces = workspaces;
      if (first || !sameRows(projects, state.projects)) write.projects = projects;
      const changed = first || upserts.length > 0 || removed.length > 0 || "cursor" in write || "workspaces" in write || "projects" in write;
      if (!changed) continue;
      state.written = current;
      state.cursor = cursor;
      state.workspaces = workspaces;
      state.projects = projects;
      try {
        deps.write(write);
      } catch (err) {
        console.error("[launch-mirror] write failed", err);
      }
    }
  };

  const schedule = (): void => {
    dirty = true;
    if (timer) return;
    timer = setTimeout(flush, delay);
  };
  const onVisibility = (): void => {
    if (deps.doc?.visibilityState === "hidden") flush();
  };
  const offs = [deps.sessions.onMetaChange(schedule), deps.catalog.subscribe(schedule)];
  deps.doc?.addEventListener("visibilitychange", onVisibility);
  // The lists that landed before the writer was installed.
  schedule();
  return () => {
    for (const off of offs) off();
    deps.doc?.removeEventListener("visibilitychange", onVisibility);
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

function sameRows<T>(a: readonly T[], b: readonly T[] | null): boolean {
  if (!b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The desktop wiring: the stores, the registry's primary and preload's write. */
export function installLaunchMirror(): () => void {
  if (isWebMode() || typeof window === "undefined") return () => {};
  return installLaunchMirrorWriter({
    sessions: sessionStore,
    catalog: workspaceStore,
    write: writeLaunchMirror,
    doc: document,
  });
}
