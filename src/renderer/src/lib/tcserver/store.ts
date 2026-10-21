import { useSyncExternalStore } from "react";
import { noteBootResume } from "../bootResume";
import type { Attachment, Block, HarnessId, Session } from "../session";
import { HARNESSES } from "../session";
import { resolveModel } from "../models";
import { Subscriptions, asPage, type Link } from "../connection";
import { modeForPolicy } from "./access";
import { applyRowBody, emptyFold, foldEvent, foldOptimisticUser, type FoldState } from "./fold";
import type { EventsPage, SessionChanges, SessionPage } from "@server/shared/wire";
import type { MirrorCursor, MirrorHost } from "@server/shared/launchMirror";
import { HISTORY_PAGE_ROWS } from "@server/shared/wireBudgets";
import type { ContextUsage } from "../contextUsage";
import { emptyThread } from "./todos";
import type { EventRow, QueuedMessage, ServerPush, SessionMeta, SessionStatus, WireSessionMeta } from "./types";

/**
 * The one session store: every server session's meta, the folded
 * transcript of each one that has been opened, and the drafts the UI
 * minted but has not sent yet. App.tsx reads the OPEN sessions as an
 * array through `useServerSessions()` and writes through `mutate()`, the
 * same updater shape `setSessions` had — so its call sites stay put.
 *
 * Local-only fields on a Session (pendingSwitch, inboxCard, noteCard,
 * handoffCard, composerSeed) never come from the server; a meta push only
 * touches the fields the meta actually changed.
 */

/** One file a running session changed on disk, from the `live-edit` push. */
export type LiveEditState = {
  path: string;
  kind: "changed" | "created" | "deleted";
  adds?: number;
  dels?: number;
  diff: string | null;
  bytes?: number;
  burst?: boolean;
  state: "editing" | "settled";
  startedTs: number;
  ts: number;
};

/** What one `live-edit` push said, for listeners that act per file. */
export type LiveEditNotice = {
  /** The watched repo root the path is relative to. */
  cwd: string;
  path: string;
  kind: "changed" | "created" | "deleted";
  settled: boolean;
  ts: number;
};
export type LiveEditListener = (sessionIds: string[], edit: LiveEditNotice) => void;

const MAX_LIVE_EDITS = 500;
const NO_EDITS: Record<string, LiveEditState> = {};
const NO_QUEUE: QueuedMessage[] = [];
const NO_IDS: readonly string[] = [];

/**
 * The slow-changing part of an open session: what the shell (App, the
 * tab strip, project grouping) needs to lay things out. Excludes the
 * transcript, busy/status and thread state, which change every turn, so a
 * `useSessionShells()` subscriber sits out streamed turns entirely.
 */
export type SessionShell = Pick<
  Session,
  | "id"
  | "environmentId"
  | "harness"
  | "model"
  | "modelSettings"
  | "runtimeMode"
  | "title"
  | "cwd"
  | "projectId"
  | "workspaceId"
  | "threadType"
  | "threadRules"
  | "createdAt"
  | "parentId"
  | "planPath"
  | "archived"
  | "agentType"
  | "providerSessionId"
  | "branch"
  | "worktreeCwd"
>;

const SHELL_KEYS: readonly (keyof SessionShell)[] = [
  "id",
  "environmentId",
  "harness",
  "model",
  "modelSettings",
  "runtimeMode",
  "title",
  "cwd",
  "projectId",
  "workspaceId",
  "threadType",
  "threadRules",
  "createdAt",
  "parentId",
  "planPath",
  "archived",
  "agentType",
  "providerSessionId",
  "branch",
  "worktreeCwd",
];

/** The previous shell when nothing the shell carries changed, else a fresh one. */
function shellOf(session: Session, previous: SessionShell | undefined): SessionShell {
  if (previous && SHELL_KEYS.every((key) => previous[key] === session[key])) return previous;
  const out = {} as Record<keyof SessionShell, unknown>;
  for (const key of SHELL_KEYS) out[key] = session[key];
  return out as SessionShell;
}

export type { Link };

/** `env|*` or `env|proj:<id>`: which environment an archived scope belongs to. */
function scopeEnvironment(scope: string): string {
  return scope.slice(0, scope.indexOf("|"));
}

/** One environment's socket as the store holds it. */
type Attached = {
  link: Link;
  subs: Subscriptions;
  detach: (() => void)[];
  listed: Promise<void> | null;
};

type Entry = {
  session: Session;
  /** null → a draft: minted locally, not created on the server yet */
  meta: SessionMeta | null;
  /** highest persisted seq folded; drives the reconnect gap replay */
  lastSeq: number;
  nextId: number;
  loaded: boolean;
  loading: Promise<void> | null;
  /** The next resume is a cold open: a tail, with history behind it. */
  coldOpen: boolean;
  /** Pushes held back while a history fetch is in flight; they fold after
   *  it so a live row never lands ahead of the older rows it follows. */
  held: EventRow[] | null;
  /** The part of the log before the tail that painted first: the rows
   *  before `beforeSeq` are still to come, and every row folded since the
   *  tail landed waits in `since` so the refold includes it. */
  head: Head | null;
  /** Remote profile: the persisted rows folded so far, oldest first, so an
   *  older page can refold the log in front of them; null on a local socket. */
  rows: EventRow[] | null;
};

type Head = {
  beforeSeq: number;
  since: EventRow[];
  fetching: boolean;
  waiters: (() => void)[];
  /** Remote profile: the older page on its way, if one is. */
  page: Promise<boolean> | null;
};

type EventsResult = EventRow[] | EventsPage;

/** One shape for both profiles: a local socket answers the rows and the
 *  renderer reads the head off their seqs; a remote one says itself. */
/** A first load asks for about this many transcript rows (prompts, tool
 *  calls, messages); the rest folds behind them. Rows, not turns: an agent
 *  thread packs tens of thousands of events into two turns. */
const TAIL_ROWS = 300;
/** Pages followed after a resume whose page says more rows come after it
 *  (the remote pager caps a page). The server answers the second request
 *  whole or as a fresh tail, so one is the norm; the bound is a guard. */
const MORE_AFTER_PAGES = 8;
/** Rows folded per slice while the head of a long log folds in the background. */
const HEAD_CHUNK = 2000;
/** Rows per `session.events` call while a long head loads: the server reads
 *  one slice per call instead of a 40k-row log in one `.all()`. */
const HEAD_FETCH = 4000;
/** A transcript whose tab left the warm set is dropped after this long. */
const UNLOAD_MS = 3000;
/** Rows fetched whole for their bodies that stay cached (remote profile). */
const ROW_BODY_CACHE = 200;
/** Transcript loads in one window above this many report a burst line. */
const BURST_WINDOW_MS = 10_000;
const BURST_LIMIT = 20;

const OPEN_STATUSES = new Set(["starting", "running", "waiting"]);
const READY_TIMEOUT_MS = 10_000;
/** How long the boot prune waits for a host's list before taking what the
 *  launch mirror had for it (CLAUDE.md "Launch: the rail paints from the
 *  launch mirror"). */
export const BOOT_SETTLE_MS = 2_000;

export function isOpenStatus(status: SessionMeta["status"]): boolean {
  return OPEN_STATUSES.has(status);
}

export function asHarness(provider: string): HarnessId {
  return (HARNESSES as string[]).includes(provider) ? (provider as HarnessId) : "claude";
}

/** The picker id for a native model id; synthesized until the catalog lands. */
export function pickerModelId(harness: HarnessId, nativeId: string): string {
  const resolved = resolveModel(harness, nativeId);
  return resolved.harness === harness && (resolved.nativeId ?? "") === nativeId
    ? resolved.id
    : `${harness}:${nativeId}`;
}

/** A fresh Session for a server meta (no transcript yet). */
export function sessionFromMeta(meta: SessionMeta): Session {
  const harness = asHarness(meta.provider);
  const base: Session = {
    id: meta.id,
    environmentId: meta.environmentId,
    harness,
    model: pickerModelId(harness, meta.model),
    modelSettings: {},
    runtimeMode: modeForPolicy(meta.permission),
    title: meta.title,
    cwd: meta.cwd,
    projectId: meta.projectId,
    workspaceId: meta.workspaceId,
    blocks: [],
    busy: isOpenStatus(meta.status),
  };
  return applyMeta(base, null, meta);
}

/** Merge what changed between two metas into a session; local fields stay. */
export function applyMeta(
  session: Session,
  prev: SessionMeta | null,
  meta: SessionMeta,
): Session {
  const changed = <K extends keyof SessionMeta>(key: K): boolean =>
    !prev || prev[key] !== meta[key];
  let next = session;
  const set = (patch: Partial<Session>): void => {
    next = { ...next, ...patch };
  };
  if (changed("provider") || changed("model")) {
    const harness = asHarness(meta.provider);
    set({ harness, model: pickerModelId(harness, meta.model) });
  }
  if (changed("reasoning") || changed("fast") || changed("ultrafast") || changed("context1m")) {
    set({
      modelSettings: {
        ...next.modelSettings,
        ...(changed("reasoning") ? { effort: meta.reasoning } : {}),
        ...(changed("fast") ? { fast: String(meta.fast) } : {}),
        ...(changed("ultrafast") ? { ultrafast: String(meta.ultrafast) } : {}),
        ...(changed("context1m") ? { context: meta.context1m ? "1m" : "200k" } : {}),
      },
    });
  }
  if (changed("permission")) set({ runtimeMode: modeForPolicy(meta.permission) });
  if (changed("title")) set({ title: meta.title });
  if (changed("cwd")) set({ cwd: meta.cwd });
  if (changed("projectId")) set({ projectId: meta.projectId });
  if (changed("workspaceId")) set({ workspaceId: meta.workspaceId });
  if (changed("nativeId")) {
    set({ providerSessionId: meta.nativeId ?? undefined });
  }
  if (changed("status")) set({ busy: isOpenStatus(meta.status) });
  if (meta.context && (!prev || prev.context !== meta.context)) {
    set({
      context: {
        used: meta.context.tokens,
        ...(meta.context.window ? { window: meta.context.window } : {}),
      },
    });
  }
  return applyThreadMeta(next, prev, meta);
}

/** The thread-level fields (type, plan, activity, tasks…) a meta carries.
 *  Also applied when a draft is adopted, since the server minted them. */
export function applyThreadMeta(
  session: Session,
  prev: SessionMeta | null,
  meta: SessionMeta,
): Session {
  const changed = <K extends keyof SessionMeta>(key: K): boolean =>
    !prev || prev[key] !== meta[key];
  let next = session;
  const set = (patch: Partial<Session>): void => {
    next = { ...next, ...patch };
  };
  if (changed("threadType")) set({ threadType: meta.threadType });
  if (changed("planPath")) set({ planPath: meta.planPath });
  if (changed("planCompletedAt")) set({ planCompletedAt: meta.planCompletedAt ?? null });
  if (changed("implementationId")) set({ implementationId: meta.implementationId ?? null });
  if (changed("planThreadId")) set({ planThreadId: meta.planThreadId ?? null });
  if (changed("parentId")) set({ parentId: meta.parentId });
  if (changed("agentType")) set({ agentType: meta.agentType });
  if (changed("status")) set({ status: meta.status });
  if (changed("archived")) set({ archived: meta.archived });
  if (changed("busySince")) set({ busySince: meta.busySince });
  if (changed("pausedAt")) set({ pausedAt: meta.pausedAt });
  if (changed("frozenActiveElapsed")) set({ frozenActiveElapsed: meta.frozenActiveElapsed });
  if (changed("treeCanContinue")) set({ treeCanContinue: meta.treeCanContinue });
  if (!prev || (prev.failure?.summary ?? null) !== (meta.failure?.summary ?? null)) set({ failure: meta.failure ?? null });
  if (changed("treeHasLiveWork")) set({ treeHasLiveWork: meta.treeHasLiveWork });
  if (changed("treeHasPaused")) set({ treeHasPaused: meta.treeHasPaused });
  if (changed("treeFrozenActiveElapsed")) set({ treeFrozenActiveElapsed: meta.treeFrozenActiveElapsed });
  if (changed("activity")) set({ activity: meta.activity ?? null });
  if (changed("activityKind")) set({ activityKind: meta.activityKind ?? null });
  if (!prev || !sameTasks(prev.tasks, meta.tasks)) set({ tasks: meta.tasks ?? null });
  if (!prev || !sameGoal(prev.goal, meta.goal)) set({ goal: meta.goal ?? null });
  return next;
}

function sameTasks(a: SessionMeta["tasks"], b: SessionMeta["tasks"]): boolean {
  if (!a || !b) return !a && !b;
  return a.done === b.done && a.total === b.total && (a.current ?? null) === (b.current ?? null);
}

function sameGoal(a: SessionMeta["goal"], b: SessionMeta["goal"]): boolean {
  if (!a || !b) return !a && !b;
  return a.condition === b.condition && a.iterations === b.iterations && a.setAt === b.setAt;
}

/**
 * The meta's reading wins over the fold's. The server keeps `context`
 * events out of the log, so all the fold ever sees is a compaction's
 * post-token count — the number a relaunch used to show as the level
 * (4.4K on a thread that had long since refilled). The meta carries the
 * last real reading, persisted on the row; the fold's only fills a
 * thread that has none.
 */
function contextAfterFold(
  current: ContextUsage | undefined,
  folded: ContextUsage | undefined,
): { context?: ContextUsage } {
  const context = current ?? folded;
  return context ? { context } : {};
}

function foldStateOf(entry: Entry): FoldState {
  return {
    blocks: entry.session.blocks,
    busy: !!entry.session.busy,
    context: entry.session.context,
    lastSeq: entry.lastSeq,
    nextId: entry.nextId,
    thread: entry.session.thread ?? emptyThread(),
  };
}

class SessionStore {
  private entries = new Map<string, Entry>();
  private openOrder: string[] = [];
  private queues = new Map<string, QueuedMessage[]>();
  private listeners = new Set<() => void>();
  private metaListeners = new Set<() => void>();
  private eventListeners = new Set<(sessionId: string, row: EventRow, session: Session) => void>();
  private addedListeners = new Set<(meta: SessionMeta) => void>();
  private openListeners = new Set<(meta: SessionMeta) => void>();
  private liveEdits = new Map<string, Record<string, LiveEditState>>();
  private liveEditListeners = new Set<LiveEditListener>();
  private queueListeners = new Set<() => void>();
  private readyDone = false;
  private idleWaiters = new Map<string, Set<() => void>>();
  private snapshot: Session[] = [];
  private ids: readonly string[] = NO_IDS;
  private shells: SessionShell[] = [];
  private version = 0;
  private pushed = { session: 0, event: 0 };
  /** `metas()` as of the last meta change; the metas hooks' stable snapshot. */
  private metasSnapshot: SessionMeta[] | null = null;
  private metaPending = false;
  private attached = new Map<string, Attached>();
  private offRegistry: (() => void) | null = null;
  private listed: Promise<void> | null = null;
  /** Which environment `listed` belongs to: the primary's list wins. */
  private listedBy: string | null = null;
  /** Environments whose first list on the current socket has landed. */
  private listedDone = new Set<string>();
  /** Environments hydrated from the launch mirror this boot, and the ids
   *  still unconfirmed by the host (a resync confirms or drops them). */
  private mirrored = new Map<string, Set<string>>();
  /** Where each host's list stands (`session.changes` head), the cursor the
   *  launch mirror saves and the next resync resumes from. */
  private cursors = new Map<string, MirrorCursor>();
  /** Woken whenever a host settles (its list lands, or the mirror paints it). */
  private settleWaiters = new Set<() => void>();
  private opened: Promise<void> = Promise.resolve();
  private markOpen: () => void = () => {};

  /** The registry, for the freshness word: data is fresh once the first
   *  list on a replacement session has landed. */
  private registryRef: {
    markFresh?(environmentId: string, fresh: boolean): void;
    statusOf?(environmentId: string): { lastHello: { environmentId: string } | null };
    primaryEnvironmentId?: string;
  } | null = null;

  /** Follow the registry: every environment's link attaches as it is added
   *  and its data goes when the environment is removed. */
  connect(registry: {
    onLink(listener: (link: Link, event: "added" | "removed") => void): () => void;
    markFresh?(environmentId: string, fresh: boolean): void;
    statusOf?(environmentId: string): { lastHello: { environmentId: string } | null };
    primaryEnvironmentId?: string;
  }): void {
    this.offRegistry?.();
    this.registryRef = registry;
    this.offRegistry = registry.onLink((link, event) => {
      if (event === "added") this.attach(link);
      else this.detach(link.environmentId);
    });
  }

  /** Attach one environment's link; safe to call again with the same link. */
  attach(link: Link): void {
    const current = this.attached.get(link.environmentId);
    if (current?.link === link) return;
    if (current) this.detach(link.environmentId);
    if (this.attached.size === 0) {
      this.opened = new Promise<void>((resolve) => {
        this.markOpen = resolve;
      });
    }
    const subs = new Subscriptions(link);
    const entry: Attached = { link, subs, detach: [], listed: null };
    const list = (): void => {
      entry.listed = this.resync(link)
        .then(() => this.registryRef?.markFresh?.(link.environmentId, true))
        .catch(() => undefined)
        .then(() => {
          this.readyDone = true;
          this.listedDone.add(link.environmentId);
          this.noteSettled();
        });
      // Boot waits on the primary environment's first list (this machine's
      // server); a mirrored remote host registered ahead of it never stands in.
      const primary = this.registryRef?.primaryEnvironmentId;
      if (!this.listed || (link.environmentId === primary && this.listedBy !== primary)) {
        this.listed = entry.listed;
        this.listedBy = link.environmentId;
      }
      this.markOpen();
    };
    entry.detach = [link.onPush((push) => this.onPush(push, link.environmentId)), link.onOpen(list)];
    this.attached.set(link.environmentId, entry);
    if (link.connected) list();
  }

  /** The environment is gone for good: its sessions leave the store. */
  detach(environmentId: string): void {
    const entry = this.attached.get(environmentId);
    if (!entry) return;
    for (const off of entry.detach) off();
    entry.subs.dispose();
    this.attached.delete(environmentId);
    this.listedDone.delete(environmentId);
    this.mirrored.delete(environmentId);
    this.cursors.delete(environmentId);
    for (const [id, e] of [...this.entries]) {
      if (e.meta ? e.meta.environmentId === environmentId : e.session.environmentId === environmentId) this.drop(id);
    }
    this.bump();
    this.bumpMeta();
  }

  /** The environments attached, in attach order. */
  environmentIds(): string[] {
    return [...this.attached.keys()];
  }

  /** The link a session's requests ride on. */
  linkFor(sessionId: string): Link | undefined {
    const environmentId = this.environmentOf(sessionId);
    return environmentId ? this.attached.get(environmentId)?.link : undefined;
  }

  environmentOf(sessionId: string): string | undefined {
    const entry = this.entries.get(sessionId);
    if (!entry) return undefined;
    return entry.meta?.environmentId ?? entry.session.environmentId;
  }

  /** The attached environment a host's own id names: `local` for this
   *  machine's server (whose hello carries its real id), a saved host by its
   *  id. Undefined when no attached environment is that host. */
  attachedEnvironmentFor(hostId: string): string | undefined {
    if (this.attached.has(hostId)) return hostId;
    for (const id of this.attached.keys()) {
      if (this.registryRef?.statusOf?.(id).lastHello?.environmentId === hostId) return id;
    }
    return undefined;
  }

  /** The host id an attached environment answers as (the inverse of attachedEnvironmentFor). */
  hostIdOf(environmentId: string): string {
    return this.registryRef?.statusOf?.(environmentId).lastHello?.environmentId ?? environmentId;
  }

  linkOfEnvironment(environmentId: string): Link | undefined {
    return this.attached.get(environmentId)?.link;
  }

  private linkOf(entry: Entry): Link | undefined {
    return this.attached.get(entry.meta?.environmentId ?? entry.session.environmentId)?.link;
  }

  private subsOf(entry: Entry): Subscriptions | undefined {
    return this.attached.get(entry.meta?.environmentId ?? entry.session.environmentId)?.subs;
  }

  private anyLink(): Link | undefined {
    for (const a of this.attached.values()) if (a.link.connected) return a.link;
    return this.attached.values().next().value?.link;
  }

  /** Test seam. */
  reset(): void {
    this.offRegistry?.();
    this.offRegistry = null;
    for (const a of this.attached.values()) {
      for (const off of a.detach) off();
      a.subs.dispose();
    }
    this.attached.clear();
    this.opened = Promise.resolve();
    for (const entry of this.entries.values()) this.settleHead(entry);
    this.entries.clear();
    this.openOrder = [];
    this.queues.clear();
    this.liveEdits.clear();
    this.listed = null;
    this.listedBy = null;
    this.listedDone.clear();
    this.mirrored.clear();
    this.cursors.clear();
    this.settleWaiters.clear();
    this.readyDone = false;
    this.archivedScopes.clear();
    this.archivedLoads.clear();
    this.mounted = null;
    this.rowBodies.clear();
    this.rowBodyLoads.clear();
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = null;
    this.burst = { since: 0, byWhy: new Map(), reported: false };
    this.bump();
  }

  // ── reads ──────────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The open sessions, in the order App last set. Stable until a change. */
  getSnapshot = (): Session[] => this.snapshot;

  /** Open session ids in order. Same array until a session opens, closes or moves. */
  getIds = (): readonly string[] => this.ids;

  /** Open sessions' shells in order. Same array until a shell field changes. */
  getShells = (): SessionShell[] => this.shells;

  /** Fires when the server's session set or any meta changes (not per event). */
  onMetaChange(listener: () => void): () => void {
    this.metaListeners.add(listener);
    return () => {
      this.metaListeners.delete(listener);
    };
  }

  /** Fires after each event row folds, with the session as it now reads. */
  onEvent(listener: (sessionId: string, row: EventRow, session: Session) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /** Fires for a top-level session the server created after boot (a plan
   *  handoff, a model's app_start_thread) — the cue to open a tab for it. */
  onSessionAdded(listener: (meta: SessionMeta) => void): () => void {
    this.addedListeners.add(listener);
    return () => {
      this.addedListeners.delete(listener);
    };
  }

  /** Fires when something asks for a known session to come forward (an
   *  appshot's target). Unlike `onSessionAdded`, this is the user's ask. */
  onOpenRequested(listener: (meta: SessionMeta) => void): () => void {
    this.openListeners.add(listener);
    return () => {
      this.openListeners.delete(listener);
    };
  }

  /** Fires when any session's live edits change, with what the push said. */
  onLiveEdit(listener: LiveEditListener): () => void {
    this.liveEditListeners.add(listener);
    return () => {
      this.liveEditListeners.delete(listener);
    };
  }

  /** Files this session changed on disk during the current run, by path. */
  liveEditsOf(id: string): Record<string, LiveEditState> {
    return this.liveEdits.get(id) ?? NO_EDITS;
  }

  get(id: string): Session | undefined {
    return this.entries.get(id)?.session;
  }

  metaOf(id: string): SessionMeta | null {
    return this.entries.get(id)?.meta ?? null;
  }

  /** Cumulative `session` and `event` pushes received; the stall recorder differences them. */
  pushCounts(): { session: number; event: number } {
    return { session: this.pushed.session, event: this.pushed.event };
  }

  /** Dev facade only (`__app.feed`, lib/appFacade.ts): a synthetic push takes
   *  the exact path a server frame takes. An injected session exists nowhere
   *  but here, so a draft it adopts counts as loaded and nothing is fetched. */
  injectPush(push: ServerPush, environmentId: string): void {
    const draft = push.push === "session" && this.entries.get(push.session.id)?.meta === null;
    this.onPush(push, environmentId);
    if (!draft) return;
    const entry = this.entries.get(push.session.id);
    if (entry) {
      entry.loaded = true;
      entry.session = { ...entry.session, loaded: true };
    }
  }

  /** Every server-known meta (drafts excluded). The same array until a meta changes. */
  metas(): SessionMeta[] {
    if (this.metasSnapshot) return this.metasSnapshot;
    const out: SessionMeta[] = [];
    for (const entry of this.entries.values()) if (entry.meta) out.push(entry.meta);
    return (this.metasSnapshot = out);
  }

  isDraft(id: string): boolean {
    const entry = this.entries.get(id);
    return !entry || entry.meta === null;
  }

  isOpen(id: string): boolean {
    return this.openOrder.includes(id);
  }

  queueOf(id: string): QueuedMessage[] {
    return this.queues.get(id) ?? NO_QUEUE;
  }

  /** Fires when any session's queue changes. */
  onQueueChange(listener: () => void): () => void {
    this.queueListeners.add(listener);
    return () => {
      this.queueListeners.delete(listener);
    };
  }

  /** Replace a session's queue view: a `queue.list` reply or an optimistic
   *  reorder. The next `queue` push overwrites it. */
  setQueue(id: string, items: QueuedMessage[]): void {
    this.queues.set(id, items);
    for (const l of this.queueListeners) l();
  }

  /** Resolves when the session's turn has settled (busy false). */
  waitIdle(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || !entry.session.busy) return Promise.resolve();
    return new Promise((resolve) => {
      let set = this.idleWaiters.get(id);
      if (!set) {
        set = new Set();
        this.idleWaiters.set(id, set);
      }
      set.add(resolve);
    });
  }

  // ── server sync ────────────────────────────────────────────────────

  /** Archived scopes already fetched: `proj:<id>` for one project's archived
   *  threads (the header's shelf), `*` for all of them (search, a deep
   *  link). The default list carries only unarchived sessions, so the
   *  thousands of archived metas never ride the boot frame. */
  private archivedScopes = new Set<string>();
  private archivedLoads = new Map<string, Promise<void>>();

  private archivedParams(scope: string): Record<string, unknown> {
    const what = scope.slice(scope.indexOf("|") + 1);
    return what === "*" ? { archived: true } : { archived: true, projectId: what.slice(5) };
  }

  private isRemote(entry: Entry): boolean {
    return this.linkOf(entry)?.profile === "remote";
  }

  /** `session.list`, whole. A local socket answers the array; a remote one
   *  a page at a time (working threads first), each merged as it lands so
   *  the shell paints from the first page while the rest walk in. */
  private async fetchList(link: Link, params: Record<string, unknown> | undefined): Promise<SessionMeta[]> {
    const environmentId = link.environmentId;
    const all: SessionMeta[] = [];
    let cursor: string | null = null;
    for (;;) {
      const result: WireSessionMeta[] | SessionPage = await link.request<WireSessionMeta[] | SessionPage>(
        "session.list",
        cursor ? { ...(params ?? {}), cursor } : params,
      );
      if (Array.isArray(result)) return result.map((meta) => ({ ...meta, environmentId }));
      for (const wire of result.sessions ?? []) {
        const meta: SessionMeta = { ...wire, environmentId };
        all.push(meta);
        this.mergeMeta(meta);
      }
      this.bumpMeta();
      cursor = result.cursor;
      if (!cursor) return all;
    }
  }

  /** Fetch the archived metas of one project (or all) on one environment,
   *  once per socket. */
  ensureArchived(environmentId: string, projectId?: string): Promise<void> {
    const link = this.attached.get(environmentId)?.link;
    const scope = `${environmentId}|${projectId ? `proj:${projectId}` : "*"}`;
    if (!link || this.archivedScopes.has(scope) || this.archivedScopes.has(`${environmentId}|*`))
      return Promise.resolve();
    const inFlight = this.archivedLoads.get(scope);
    if (inFlight) return inFlight;
    const load = this.fetchList(link, this.archivedParams(scope))
      .then((metas) => {
        for (const meta of metas ?? []) this.mergeMeta(meta);
        this.archivedScopes.add(scope);
        this.bumpMeta();
      })
      .catch(() => undefined)
      .finally(() => this.archivedLoads.delete(scope));
    this.archivedLoads.set(scope, load);
    return load;
  }

  /** The meta for `id`, fetching every environment's archived set when the
   *  live lists lack it (a tab or link to a thread archived since). */
  async ensureMeta(id: string): Promise<SessionMeta | null> {
    if (!this.metaOf(id))
      await Promise.all(this.environmentIds().map((environmentId) => this.ensureArchived(environmentId)));
    return this.metaOf(id);
  }

  private archivedScopeLoaded(meta: SessionMeta): boolean {
    return (
      this.archivedScopes.has(`${meta.environmentId}|*`) ||
      (!!meta.projectId && this.archivedScopes.has(`${meta.environmentId}|proj:${meta.projectId}`))
    );
  }

  // ── the launch mirror ──────────────────────────────────────────────

  /**
   * Paint from the launch mirror before any socket is up: every host's
   * summaries land as metas (stamped with the host they came from) and its
   * cursor is where the resync resumes. A mirrored row is unconfirmed until
   * the host lists: `resync` updates it in place, or drops it quietly when
   * the host no longer has it. Synchronous, so the first render has the rows.
   */
  hydrate(hosts: readonly MirrorHost[]): void {
    let any = false;
    for (const host of hosts) {
      const ids = new Set<string>();
      for (const summary of host.sessions) {
        if (typeof summary.id !== "string" || this.entries.has(summary.id)) continue;
        const meta = { ...(summary as unknown as SessionMeta), environmentId: host.environmentId };
        this.mergeMeta(meta);
        ids.add(meta.id);
        any = true;
      }
      this.mirrored.set(host.environmentId, ids);
      if (host.cursor) this.cursors.set(host.environmentId, host.cursor);
    }
    this.noteSettled();
    if (!any) return;
    this.bump();
    this.bumpMeta();
  }

  private noteSettled(): void {
    const waiters = [...this.settleWaiters];
    this.settleWaiters.clear();
    for (const wake of waiters) wake();
  }

  /** The attached environments neither listed on this socket nor painted from the mirror. */
  private unsettled(): string[] {
    return [...this.attached.keys()].filter((id) => !this.mirrored.has(id) && !this.listedDone.has(id));
  }

  /** The host's list cursor: what the launch mirror saves. Null until the
   *  host has answered `session.changes` once this boot or the mirror had one. */
  cursorOf(environmentId: string): MirrorCursor | null {
    return this.cursors.get(environmentId) ?? null;
  }

  /** The environment painted from the mirror this boot and not yet confirmed by its host. */
  isMirrored(environmentId: string): boolean {
    return this.mirrored.has(environmentId);
  }

  /** The environments whose list has landed on the current socket; the
   *  launch mirror writes only these (a mirrored host would be rewritten from itself). */
  listedEnvironmentIds(): string[] {
    return [...this.listedDone];
  }

  /**
   * The environments the rail can paint: each attached host once it has
   * listed, at once for one the mirror had rows for, else at the deadline.
   * The boot prune reads the known set from this, so a host away at boot
   * never holds it; the mirror says what threads that host had. A host
   * whose link opens inside the deadline counts once its list lands.
   */
  async settledEnvironments(timeoutMs = BOOT_SETTLE_MS): Promise<Set<string>> {
    let timedOut = false;
    const deadline = new Promise<void>((r) =>
      setTimeout(() => {
        timedOut = true;
        r();
      }, timeoutMs),
    );
    await Promise.race([this.opened, deadline]);
    while (!timedOut && this.unsettled().length > 0) {
      await Promise.race([new Promise<void>((r) => this.settleWaiters.add(r)), deadline]);
    }
    return new Set<string>([...this.mirrored.keys(), ...this.listedDone]);
  }

  /** Resolves once every attached environment has rows on screen: its
   *  list landed, or the mirror painted it. The launch-timing mark. */
  async whenPainted(): Promise<void> {
    await this.opened;
    while (this.unsettled().length > 0) {
      await new Promise<void>((r) => this.settleWaiters.add(r));
    }
  }

  /**
   * Resume one host's list from its cursor: `session.changes` answers the
   * metas that changed and the ids that left since, and the whole list is
   * never fetched. False when the host says `reset` (another run of its
   * server, a cursor older than its log keeps), refuses the method (an
   * older build) or has no cursor here: the caller lists whole. Either way
   * the head that came back is the new cursor.
   */
  private async resumeList(link: Link): Promise<boolean> {
    const environmentId = link.environmentId;
    const cursor = this.cursors.get(environmentId);
    let changes: SessionChanges | null;
    try {
      changes = await link.request<SessionChanges>("session.changes", {
        afterSeq: cursor?.seq ?? 0,
        ...(cursor ? { generation: cursor.generation } : {}),
      });
    } catch {
      changes = null;
    }
    if (!changes) return false;
    this.cursors.set(environmentId, { seq: changes.seq, generation: changes.generation });
    if (changes.reset || !cursor) return false;
    for (const wire of changes.sessions) this.mergeMeta({ ...wire, environmentId });
    for (const id of changes.removed) {
      const entry = this.entries.get(id);
      if (entry?.meta && entry.meta.environmentId === environmentId) this.drop(id);
    }
    this.mirrored.delete(environmentId);
    this.bumpMeta();
    return true;
  }

  /** `session.list` on one environment (plus the archived scopes already
   *  loaded there), then replay any gap for the sessions whose panes are
   *  mounted. Runs once per replacement session of that environment. A
   *  host with a cursor here resumes from it instead (`resumeList`). */
  async resync(link: Link): Promise<void> {
    const environmentId = link.environmentId;
    if (!this.attached.has(environmentId)) return;
    if (await this.resumeList(link)) {
      await this.replayMounted(environmentId);
      return;
    }
    const lists = await Promise.all([
      this.fetchList(link, undefined),
      ...[...this.archivedScopes]
        .filter((scope) => scopeEnvironment(scope) === environmentId)
        .map((scope) => this.fetchList(link, this.archivedParams(scope)).catch(() => [] as SessionMeta[])),
    ]);
    const seen = new Set<string>();
    for (const meta of lists.flat()) {
      if (!meta) continue;
      seen.add(meta.id);
      this.mergeMeta(meta);
    }
    for (const [id, entry] of this.entries) {
      if (!entry.meta || entry.meta.environmentId !== environmentId) continue;
      // An archived meta that came by push stays until its scope is listed.
      if (!seen.has(id) && !(entry.meta.archived && !this.archivedScopeLoaded(entry.meta))) this.drop(id);
    }
    this.mirrored.delete(environmentId);
    this.bumpMeta();
    await this.replayMounted(environmentId);
  }

  /** After a list or a resume: the transcripts on screen replay their gap. */
  private async replayMounted(environmentId: string): Promise<void> {
    // Only the transcripts on screen replay their gap; a loaded one whose
    // tab is no longer mounted is dropped and fetched again if it comes
    // back. A reconnect once replayed every transcript ever opened — 2,560
    // session.events in ninety seconds, 2.9 GB of main-process RSS.
    const keep = this.mountedClosure();
    const replay: Entry[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.loaded || !entry.meta || entry.meta.environmentId !== environmentId) continue;
      if (!keep || keep.has(entry.meta.id)) replay.push(entry);
      else this.unload(entry);
    }
    await Promise.all(replay.map((entry) => this.replayGap(entry, "resync")));
    this.bump();
  }

  // ── the mounted set ────────────────────────────────────────────────

  /** Sessions whose panes are mounted (the warm tabs' leaves); null until
   *  the shell has said, when every loaded transcript counts as mounted. */
  private mounted: Set<string> | null = null;
  private unloadTimer: ReturnType<typeof setTimeout> | null = null;

  /** The shell tells the store which sessions have panes on the page; a
   *  transcript outside that set (and its subagents, which the pane's
   *  board shows) unloads after a grace period. */
  setMounted(ids: Iterable<string>): void {
    this.mounted = new Set(ids);
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = setTimeout(() => {
      this.unloadTimer = null;
      this.unloadOutsideMounted();
    }, UNLOAD_MS);
  }

  /** Mounted sessions plus their children (the agent boards). */
  private mountedClosure(): Set<string> | null {
    if (!this.mounted) return null;
    const keep = new Set(this.mounted);
    for (const entry of this.entries.values()) {
      const parent = entry.meta?.parentId;
      if (parent && keep.has(parent)) keep.add(entry.meta!.id);
    }
    return keep;
  }

  private unloadOutsideMounted(): void {
    const keep = this.mountedClosure();
    if (!keep) return;
    let dropped = 0;
    for (const entry of this.entries.values()) {
      if (!entry.loaded || !entry.meta || keep.has(entry.meta.id)) continue;
      if (this.unload(entry)) dropped++;
    }
    if (dropped) this.bump();
  }

  /** Forget a transcript: blocks and seq reset, subscription released, so
   *  the next ensureLoaded fetches it afresh. A busy session or one with a
   *  send still pending keeps its rows. Returns whether it dropped. */
  private unload(entry: Entry): boolean {
    if (!entry.meta || entry.loading) return false;
    if (entry.session.busy || entry.session.blocks.some((b) => b.pending)) return false;
    this.settleHead(entry);
    this.subsOf(entry)?.remove(entry.meta.id);
    entry.loaded = false;
    entry.lastSeq = 0;
    entry.nextId = 1;
    entry.held = null;
    entry.rows = null;
    entry.session = { ...sessionFromMeta(entry.meta), loaded: false };
    return true;
  }

  /** How many transcripts the store holds loaded (tests, the stall log). */
  loadedCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) if (entry.loaded) n++;
    return n;
  }

  // ── load bursts ────────────────────────────────────────────────────

  private burst: { since: number; byWhy: Map<string, number>; reported: boolean } = {
    since: 0,
    byWhy: new Map(),
    reported: false,
  };

  /** Count a transcript fetch under its caller; past BURST_LIMIT in one
   *  window the window reports itself once through `stall.report`, naming
   *  the call sites, so the next storm says where it came from. */
  private noteLoad(why: string): void {
    const now = Date.now();
    if (now - this.burst.since > BURST_WINDOW_MS) {
      this.burst = { since: now, byWhy: new Map(), reported: false };
    }
    this.burst.byWhy.set(why, (this.burst.byWhy.get(why) ?? 0) + 1);
    let total = 0;
    for (const n of this.burst.byWhy.values()) total += n;
    if (total <= BURST_LIMIT || this.burst.reported) return;
    this.burst.reported = true;
    const parts = [...this.burst.byWhy.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`)
      .join(",");
    const line = `transcript-burst ${total} loads in ${BURST_WINDOW_MS / 1000}s (${parts}) loaded=${this.loadedCount()} mounted=${this.mounted?.size ?? "?"}`;
    this.reportLine(line);
  }

  private reportLine(line: string): void {
    void this.anyLink()?.request("stall.report", { line }).catch(() => undefined);
  }

  /** The first `session.list` after the socket opens. Boot waits on it, but
   *  not forever: with the sidecar down the app still renders and the list
   *  fills in on connect. */
  ready(timeoutMs = READY_TIMEOUT_MS): Promise<void> {
    const listed = this.opened.then(() => this.listed ?? Promise.resolve());
    return Promise.race([listed, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
  }

  /** Fetch the transcript once and subscribe to its live pushes. `why`
   *  names the caller for the burst report. */
  ensureLoaded(id: string, why = "unknown"): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || !entry.meta) return Promise.resolve();
    if (entry.loaded) return Promise.resolve();
    if (entry.loading) return entry.loading;
    entry.loading = this.replayGap(entry, why)
      .then(() => {
        entry.loaded = true;
        entry.session = { ...entry.session, loaded: true };
        this.bump();
      })
      .finally(() => {
        entry.loading = null;
      });
    return entry.loading;
  }

  /** Loaded and every row of the log folded (no head still on its way). */
  isComplete(id: string): boolean {
    const entry = this.entries.get(id);
    return !!entry && entry.loaded && !entry.head;
  }

  /** `ensureLoaded`, then wait for the head of a tail-first load: a local
   *  socket's head folds in by itself; a remote one pages it all in here. */
  async ensureComplete(id: string): Promise<void> {
    await this.ensureLoaded(id, "complete");
    const entry = this.entries.get(id);
    if (entry?.rows) {
      while (this.entries.get(id)?.head) {
        if (!(await this.loadOlder(id))) break;
      }
      return;
    }
    const head = entry?.head;
    if (head) await new Promise<void>((resolve) => head.waiters.push(resolve));
  }

  /** The subscription set's view of one transcript: where its fold is and
   *  how a page lands. `page.reset` (D2) throws the fold away first. */
  private handlersFor(entry: Entry) {
    const id = entry.session.id;
    return {
      cursor: () => entry.lastSeq,
      begin: () => {
        entry.held = [];
      },
      page: (page: EventsPage) => {
        if (this.entries.get(id) !== entry) return;
        const coldOpen = entry.coldOpen;
        entry.coldOpen = false;
        // A remote resume whose gap outgrew the budget comes back as a fresh
        // tail: what was folded is history the next pages bring back.
        if (page.reset) this.resetFold(entry);
        if (this.isRemote(entry) && !entry.rows) entry.rows = [];
        // Seqs are contiguous from 1, so a tail that starts later has a head.
        if ((coldOpen || page.reset) && page.moreBefore && page.rows.length > 0) {
          entry.head = { beforeSeq: page.rows[0].seq, since: [], fetching: false, waiters: [], page: null };
        }
        for (const row of page.rows) this.foldRow(entry, row);
      },
      end: () => {
        const held = entry.held;
        entry.held = null;
        // The fold drops whatever history already covered.
        for (const row of held ?? []) this.applyPush(entry, row);
      },
    };
  }

  private async replayGap(entry: Entry, why: string): Promise<void> {
    const link = this.linkOf(entry);
    const subs = this.subsOf(entry);
    if (!link || !subs) return;
    const id = entry.session.id;
    if (entry.held) return;
    this.noteLoad(why);
    // A first load paints the last turns first; the rest folds behind them.
    // The cursor decides, never the loaded flag: a pane restored from a
    // saved layout is a loaded draft with no rows, and a resume from seq 0
    // on a remote socket answers the OLDEST page, turn one still open.
    const tailFirst = entry.lastSeq === 0 && !entry.head;
    entry.coldOpen = tailFirst;
    subs.add(id, this.handlersFor(entry));
    await Promise.all([
      this.resumeThrough(entry, subs, tailFirst),
      // The queue lives in server memory: a restart empties it, so the
      // strip refills from the list rather than keeping stale rows.
      link
        .request<QueuedMessage[]>("queue.list", { sessionId: id })
        .then((items) => this.setQueue(id, items ?? []))
        .catch(() => undefined),
    ]);
    // A local socket folds the whole head behind the tail; a remote one
    // pages it in on demand (loadOlder), oldest page last.
    if (entry.head && !entry.head.fetching && !entry.rows) void this.fetchHead(entry);
  }

  /** Resume, then follow a page that says rows come after it (the remote
   *  pager caps a page): the next request carries the cursor the page left,
   *  which the server answers whole or as a fresh tail (`reset`). Bounded,
   *  so a page that never stops saying so cannot hold the load open. */
  private async resumeThrough(entry: Entry, subs: Subscriptions, tailFirst: boolean): Promise<void> {
    const id = entry.session.id;
    let page = await subs.resume(id, tailFirst ? { tail: TAIL_ROWS } : {});
    for (let n = 0; page.moreAfter && page.rows.length > 0 && n < MORE_AFTER_PAGES; n++) {
      if (this.entries.get(id) !== entry) return;
      page = await subs.resume(id);
    }
  }

  /** Drop a transcript's fold so a fresh tail can take its place; the
   *  user's own unechoed turns stay. */
  private resetFold(entry: Entry): void {
    if (!entry.meta) return;
    const pending = entry.session.blocks.filter((b) => b.pending);
    this.settleHead(entry);
    entry.lastSeq = 0;
    entry.nextId = 1;
    if (entry.rows) entry.rows = [];
    entry.session = { ...sessionFromMeta(entry.meta), loaded: entry.session.loaded, blocks: pending };
  }

  /** Remote profile: whether rows older than the loaded ones remain on the server. */
  hasOlderHistory(id: string): boolean {
    return !!this.entries.get(id)?.head;
  }

  /** Remote profile: fetch one older page below what is loaded and refold
   *  the log with it in front. Resolves to whether more remain; a page
   *  already on its way is awaited, not doubled. */
  loadOlder(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    const head = entry?.head;
    if (!entry || !head) return Promise.resolve(false);
    const link = this.linkOf(entry);
    if (!entry.rows || !link) return Promise.resolve(true);
    if (head.page) return head.page;
    const live = (): boolean => this.entries.get(id) === entry && entry.head === head;
    head.fetching = true;
    head.page = (async (): Promise<boolean> => {
      try {
        const result = await link.request<EventsResult>("session.events", {
          sessionId: id,
          afterSeq: 0,
          beforeSeq: head.beforeSeq,
          tail: HISTORY_PAGE_ROWS,
        });
        if (!live() || !entry.rows) return false;
        const page = asPage(result, true);
        // The rows array stays the one pushes append to while this folds,
        // so a row that lands mid-way is folded by the index loop below.
        const rows = [...page.rows, ...entry.rows];
        entry.rows = rows;
        const cwd = entry.session.cwd;
        let state = emptyFold();
        for (let i = 0; i < rows.length; i += HEAD_CHUNK) {
          for (const row of rows.slice(i, i + HEAD_CHUNK)) state = foldEvent(state, row, cwd);
          if (i + HEAD_CHUNK < rows.length) await new Promise((r) => setTimeout(r, 0));
          if (!live()) return false;
        }
        const pending = entry.session.blocks.filter((b) => b.pending);
        entry.lastSeq = Math.max(state.lastSeq, entry.lastSeq);
        entry.nextId = Math.max(state.nextId, entry.nextId);
        entry.session = {
          ...entry.session,
          blocks: pending.length ? [...state.blocks, ...pending] : state.blocks,
          thread: state.thread,
          ...contextAfterFold(entry.session.context, state.context),
        };
        if (page.moreBefore && page.rows.length > 0) {
          head.beforeSeq = page.rows[0].seq;
          head.fetching = false;
          head.page = null;
        } else this.settleHead(entry);
        this.bump();
        return !!entry.head;
      } catch {
        if (live()) {
          head.fetching = false;
          head.page = null;
        }
        return true;
      }
    })();
    return head.page;
  }

  // ── bodies off the wire (remote profile) ───────────────────────────

  /** Rows fetched whole, by `sessionId:seq`, so a block fetched once is
   *  whole again after a refold without another round trip. */
  private rowBodies = new Map<string, EventRow>();
  private rowBodyLoads = new Map<string, Promise<EventRow | null>>();

  private fetchRowBody(sessionId: string, seq: number): Promise<EventRow | null> {
    const key = `${sessionId}:${seq}`;
    const cached = this.rowBodies.get(key);
    if (cached) return Promise.resolve(cached);
    const inFlight = this.rowBodyLoads.get(key);
    if (inFlight) return inFlight;
    const entry = this.entries.get(sessionId);
    const link = entry ? this.linkOf(entry) : undefined;
    if (!link) return Promise.resolve(null);
    const load = link
      .request<{ row: EventRow }>("session.rowBody", { sessionId, seq })
      .then((result) => {
        const row = result?.row ?? null;
        if (row) {
          if (this.rowBodies.size >= ROW_BODY_CACHE) {
            const oldest = this.rowBodies.keys().next().value;
            if (oldest !== undefined) this.rowBodies.delete(oldest);
          }
          this.rowBodies.set(key, row);
        }
        return row;
      })
      .catch(() => null)
      .finally(() => this.rowBodyLoads.delete(key));
    this.rowBodyLoads.set(key, load);
    return load;
  }

  private patchTool(entry: Entry, blockId: string, patch: Partial<NonNullable<Block["tool"]>>): void {
    const idx = entry.session.blocks.findIndex((b) => b.id === blockId);
    if (idx < 0) return;
    const blocks = entry.session.blocks.slice();
    const prev = blocks[idx];
    blocks[idx] = { ...prev, tool: { ...prev.tool, ...patch } };
    entry.session = { ...entry.session, blocks };
    this.bump();
  }

  /** Remote profile: fetch the rows whose bodies stayed on the server for
   *  this block and fold them over it; the block loses its `omitted` once
   *  whole, or keeps it marked failed. Safe to call again. */
  async loadRowBodies(block: Block): Promise<void> {
    const want = block.tool?.omitted;
    if (!want || want.loading) return;
    const entry = this.entries.get(want.sessionId);
    if (!entry) return;
    this.patchTool(entry, block.id, { omitted: { ...want, loading: true, failed: false } });
    const rows = await Promise.all(want.seqs.map((seq) => this.fetchRowBody(want.sessionId, seq)));
    if (this.entries.get(want.sessionId) !== entry) return;
    const full = rows.filter((r): r is EventRow => !!r).sort((a, b) => a.seq - b.seq);
    if (full.length < want.seqs.length) {
      this.patchTool(entry, block.id, { omitted: { ...want, loading: false, failed: true } });
      return;
    }
    let blocks = entry.session.blocks;
    for (const row of full) blocks = applyRowBody(blocks, entry.session.cwd, row);
    const idx = blocks.findIndex((b) => b.id === block.id);
    if (idx >= 0) {
      if (blocks === entry.session.blocks) blocks = blocks.slice();
      blocks[idx] = { ...blocks[idx], tool: { ...blocks[idx].tool, omitted: undefined } };
    }
    entry.session = { ...entry.session, blocks };
    // A refold from the kept rows folds the whole row from now on.
    if (entry.rows) {
      for (const row of full) {
        const at = entry.rows.findIndex((r) => r.seq === row.seq);
        if (at >= 0) entry.rows[at] = row;
      }
    }
    this.bump();
  }

  /** Fetch the rows before a tail-first paint and refold the whole log
   *  from the start, in slices off the main path, then swap it in. Ids
   *  come from seqs, so the blocks the tail already showed keep theirs. */
  private async fetchHead(entry: Entry): Promise<void> {
    const head = entry.head;
    const link = this.linkOf(entry);
    if (!head || head.fetching || !link) return;
    const id = entry.session.id;
    head.fetching = true;
    const live = (): boolean => this.entries.get(id) === entry && entry.head === head;
    const cwd = entry.session.cwd;
    let state = emptyFold();
    // The head arrives in slices: each call reads at most HEAD_FETCH rows
    // on the server and folds here in HEAD_CHUNK pieces with a yield
    // between, so neither process holds a 40k-row log in one breath.
    let cursor = 0;
    for (;;) {
      let rows: EventRow[];
      try {
        rows = await link.request<EventRow[]>("session.events", {
          sessionId: id,
          afterSeq: cursor,
          beforeSeq: head.beforeSeq,
          limit: HEAD_FETCH,
        });
      } catch {
        // The next reconnect replay tries again.
        head.fetching = false;
        return;
      }
      if (!live()) return;
      for (let i = 0; i < rows.length; i += HEAD_CHUNK) {
        if (!live()) return;
        for (const row of rows.slice(i, i + HEAD_CHUNK)) state = foldEvent(state, row, cwd);
        if (i + HEAD_CHUNK < rows.length) await new Promise((r) => setTimeout(r, 0));
      }
      if (rows.length < HEAD_FETCH) break;
      cursor = rows[rows.length - 1].seq;
      await new Promise((r) => setTimeout(r, 0));
    }
    if (!live()) return;
    // Pushes that landed while the head folded are in `since`, after the tail.
    for (const row of head.since) state = foldEvent(state, row, cwd);
    const pending = entry.session.blocks.filter((b) => b.pending);
    entry.lastSeq = Math.max(state.lastSeq, entry.lastSeq);
    entry.nextId = Math.max(state.nextId, entry.nextId);
    entry.session = {
      ...entry.session,
      blocks: pending.length ? [...state.blocks, ...pending] : state.blocks,
      thread: state.thread,
      ...contextAfterFold(entry.session.context, state.context),
    };
    this.settleHead(entry);
    this.bump();
  }

  private settleHead(entry: Entry): void {
    const head = entry.head;
    if (!head) return;
    entry.head = null;
    for (const w of head.waiters) w();
  }

  private applyPush(entry: Entry, row: EventRow): void {
    if (entry.held) {
      entry.held.push(row);
      return;
    }
    if (this.foldRow(entry, row)) {
      this.bumpSoon();
      for (const l of this.eventListeners) l(row.sessionId, row, entry.session);
    }
  }

  private onPush(push: ServerPush, environmentId: string): void {
    switch (push.push) {
      case "session": {
        this.pushed.session += 1;
        const fresh = !this.entries.has(push.session.id);
        const meta: SessionMeta = { ...push.session, environmentId };
        this.mergeMeta(meta);
        // The view is current at once; listeners hear once per frame, so a
        // fleet pushing many times a second costs one reconcile per frame
        // and never interrupts a render in progress.
        this.bumpSoon();
        this.bumpMetaSoon();
        if (fresh) this.noteAdded(meta);
        break;
      }
      case "sessions": {
        for (const session of push.sessions) this.onPush({ push: "session", session }, environmentId);
        break;
      }
      case "events": {
        this.pushed.event += push.rows.length;
        const entry = this.entries.get(push.sessionId);
        if (entry) for (const row of push.rows) this.applyPush(entry, row);
        break;
      }
      case "live-edits": {
        for (const item of push.items) this.onPush({ push: "live-edit", ...item }, environmentId);
        break;
      }
      case "live-edit": {
        for (const sid of push.sessionIds) {
          const cur = { ...(this.liveEdits.get(sid) ?? {}) };
          const prev = cur[push.edit.path];
          cur[push.edit.path] = {
            path: push.edit.path,
            kind: push.edit.kind,
            adds: push.edit.adds ?? prev?.adds,
            dels: push.edit.dels ?? prev?.dels,
            diff: push.edit.diff ?? prev?.diff ?? null,
            bytes: push.edit.bytes,
            burst: push.edit.burst,
            state: push.edit.settled ? "settled" : "editing",
            startedTs: prev?.startedTs ?? push.edit.ts,
            ts: push.edit.ts,
          };
          const keys = Object.keys(cur);
          if (keys.length > MAX_LIVE_EDITS) delete cur[keys[0]];
          this.liveEdits.set(sid, cur);
        }
        {
          const notice: LiveEditNotice = {
            cwd: push.cwd,
            path: push.edit.path,
            kind: push.edit.kind,
            settled: !!push.edit.settled,
            ts: push.edit.ts,
          };
          for (const l of this.liveEditListeners) l(push.sessionIds, notice);
        }
        break;
      }
      case "event": {
        this.pushed.event += 1;
        const entry = this.entries.get(push.row.sessionId);
        if (entry) this.applyPush(entry, push.row);
        break;
      }
      case "session-removed":
        // A removal speaks for the environment that sent it: the copy another
        // host holds under the same id (a thread that moved there) stays.
        for (const id of push.sessionIds) {
          const entry = this.entries.get(id);
          if (entry && (entry.meta?.environmentId ?? entry.session.environmentId) !== environmentId) continue;
          this.drop(id);
        }
        this.bumpSoon();
        this.bumpMetaSoon();
        break;
      case "session-moved":
        this.onMoved(push.sessionIds, environmentId, push.to);
        break;
      case "boot-resume":
        noteBootResume(environmentId, push.count, push.at);
        break;
      case "queue":
        this.setQueue(push.sessionId, push.items);
        break;
      default:
        break;
    }
  }

  private foldRow(entry: Entry, row: EventRow): boolean {
    entry.head?.since.push(row);
    const before = foldStateOf(entry);
    const after = foldEvent(before, row, entry.session.cwd);
    if (after === before) return false;
    if (entry.rows && !row.ephemeral && row.seq >= 0) entry.rows.push(row);
    entry.lastSeq = after.lastSeq;
    entry.nextId = after.nextId;
    entry.session = {
      ...entry.session,
      blocks: after.blocks,
      busy: after.busy,
      thread: after.thread,
      ...contextAfterFold(entry.session.context, after.context),
    };
    return true;
  }

  private mergeMeta(meta: SessionMeta): void {
    this.metasSnapshot = null;
    const entry = this.entries.get(meta.id);
    if (!entry) {
      this.entries.set(meta.id, {
        session: sessionFromMeta(meta),
        meta,
        lastSeq: 0,
        nextId: 1,
        loaded: false,
        loading: null,
        coldOpen: false,
        held: null,
        head: null,
        rows: null,
      });
      return;
    }
    if (!entry.meta) {
      // Draft adoption: the server echoes what the UI sent, so the local
      // view stays; only what the server adds comes across.
      // A pane restored from a saved layout before its host listed it is
      // a stub too: the host that answers for it is the one it lives on.
      entry.session = applyThreadMeta(
        {
          ...entry.session,
          environmentId: meta.environmentId,
          busy: entry.session.busy || isOpenStatus(meta.status),
          ...(meta.nativeId ? { providerSessionId: meta.nativeId } : {}),
        },
        null,
        meta,
      );
    } else {
      // The same thread, now answered by another host (it moved there):
      // follow it before the old host's removal arrives.
      if (entry.meta.environmentId !== meta.environmentId) this.repoint(entry, entry.meta.environmentId, meta.environmentId);
      entry.session = applyMeta(entry.session, entry.meta, meta);
      // A settled session with no send in flight is not busy, whatever a
      // lost `running` push left behind.
      if (
        entry.session.busy &&
        !isOpenStatus(meta.status) &&
        !entry.session.blocks.some((b) => b.pending)
      ) {
        entry.session = { ...entry.session, busy: false };
      }
    }
    entry.meta = meta;
  }

  /** A server-minted top-level session, first seen after boot. Children
   *  render on their parent's board and archived ones are history. */
  private noteAdded(meta: SessionMeta): void {
    if (!this.readyDone || meta.parentId || meta.archived) return;
    for (const l of this.addedListeners) l(meta);
  }

  /** Ask the shell to show a session it already knows: App opens or
   *  focuses its tab. A server-made thread goes through `noteAdded`
   *  instead and opens in the background. */
  requestOpen(id: string): void {
    const meta = this.metaOf(id);
    if (!meta) return;
    for (const l of this.openListeners) l(meta);
  }

  /** Listeners for threads that moved to another host (open tabs follow them). */
  private movedListeners = new Set<(sessionIds: string[], from: string, to: string) => void>();

  onSessionMoved(listener: (sessionIds: string[], from: string, to: string) => void): () => void {
    this.movedListeners.add(listener);
    return () => {
      this.movedListeners.delete(listener);
    };
  }

  /** `session-moved` from `from`: the thread and its subagents now live on
   *  host `hostId`. Entries keep their transcript and point at the new
   *  environment; a loaded one resumes there from its last seq (a move keeps
   *  every seq). A host this window does not attach leaves the entry for the
   *  removal that follows. */
  private onMoved(sessionIds: string[], from: string, hostId: string): void {
    const to = this.attachedEnvironmentFor(hostId);
    if (!to || to === from) return;
    const moved: string[] = [];
    for (const id of sessionIds) {
      const entry = this.entries.get(id);
      if (!entry || (entry.meta?.environmentId ?? entry.session.environmentId) !== from) continue;
      this.repoint(entry, from, to);
      moved.push(id);
    }
    if (moved.length === 0) return;
    this.metasSnapshot = null;
    this.bumpSoon();
    this.bumpMetaSoon();
    for (const l of this.movedListeners) l(moved, from, to);
  }

  private repoint(entry: Entry, from: string, to: string): void {
    const id = entry.session.id;
    this.attached.get(from)?.subs.remove(id);
    if (entry.meta) entry.meta = { ...entry.meta, environmentId: to };
    entry.session = { ...entry.session, environmentId: to };
    this.metasSnapshot = null;
    const subs = this.attached.get(to)?.subs;
    if (entry.loaded && subs) {
      subs.add(id, this.handlersFor(entry));
      const tailFirst = entry.lastSeq === 0 && !entry.head;
      entry.coldOpen = tailFirst;
      void this.resumeThrough(entry, subs, tailFirst).catch(() => undefined);
    }
  }

  private drop(id: string): void {
    this.metasSnapshot = null;
    const entry = this.entries.get(id);
    if (entry) this.settleHead(entry);
    this.entries.delete(id);
    this.queues.delete(id);
    this.liveEdits.delete(id);
    this.openOrder = this.openOrder.filter((x) => x !== id);
  }

  // ── writes ─────────────────────────────────────────────────────────

  /**
   * The `setSessions` shim. The updater sees the open sessions and returns
   * the new open set: sessions it drops close, new ones open (drafts until
   * their first send), edited ones replace their entry's view.
   */
  mutate = (updater: Session[] | ((prev: Session[]) => Session[])): void => {
    const prev = this.snapshot;
    const next = typeof updater === "function" ? updater(prev) : updater;
    if (next === prev) return;
    const order: string[] = [];
    for (const session of next) {
      order.push(session.id);
      const entry = this.entries.get(session.id);
      if (!entry) {
        this.entries.set(session.id, {
          session,
          meta: null,
          lastSeq: 0,
          nextId: 1,
          loaded: true,
          loading: null,
          coldOpen: false,
          held: null,
          head: null,
          rows: null,
        });
      } else if (entry.session !== session) {
        entry.session = session;
      }
    }
    this.openOrder = order;
    this.bump();
  };

  /** A draft just got created on the server: adopt its meta. A session the
   *  UI created whole (a plan handoff) counts as added, once, whether the
   *  create response or the server's push lands first. */
  adopt(meta: SessionMeta): void {
    const fresh = !this.entries.has(meta.id);
    this.mergeMeta(meta);
    const entry = this.entries.get(meta.id);
    if (entry) {
      entry.loaded = true;
      const subs = this.subsOf(entry);
      if (subs && !subs.isLive(meta.id)) {
        subs.add(meta.id, this.handlersFor(entry));
        void subs.subscribe(meta.id).catch(() => undefined);
      }
    } else {
      this.mergeMeta(meta);
    }
    this.bump();
    this.bumpMeta();
    if (fresh) this.noteAdded(meta);
  }

  /** Show the user's message now; the echoed row claims it. */
  appendOptimisticUser(
    id: string,
    text: string,
    attachments: Attachment[] = [],
    extra?: { secondOpinion?: Block["secondOpinion"]; noteCard?: Block["noteCard"] },
    newPass?: boolean,
  ): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const after = foldOptimisticUser(foldStateOf(entry), text, attachments, extra, newPass);
    entry.nextId = after.nextId;
    entry.session = { ...entry.session, blocks: after.blocks, busy: true, thread: after.thread };
    this.bump();
  }

  /** Patch one open session in place (title, busy, …). */
  patch(id: string, patch: Partial<Session>): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.session = { ...entry.session, ...patch };
    this.bump();
  }

  private bumpMeta(): void {
    this.metaPending = false;
    for (const listener of this.metaListeners) listener();
  }

  /** Meta listeners hear with the next flush (or the next sync bump, whichever is first). */
  private bumpMetaSoon(): void {
    this.metaPending = true;
    this.bumpSoon();
  }

  private notifyPending: number | null = null;

  /**
   * Streamed events arrive far faster than frames paint. The snapshot updates
   * now; listeners hear once per frame, so React reconciles once per frame
   * instead of once per delta. A synchronous bump() flushes it early.
   */
  private bumpSoon(): void {
    this.version += 1;
    this.snapshot = this.buildSnapshot();
    if (this.notifyPending != null) return;
    const flush = () => {
      if (this.notifyPending == null) return;
      this.notifyPending = null;
      this.bump();
    };
    this.notifyPending =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(flush)
        : (setTimeout(flush, 0) as unknown as number);
  }

  /**
   * Recompute the id list and shells, keeping identities where nothing
   * changed. A streamed event bumps once per frame with no shell field
   * touched, so this allocates nothing on that path: a new array only
   * once a shell differs, copied from the first change on.
   */
  private refreshProjections(): void {
    const sessions = this.snapshot;
    const sameIds =
      sessions.length === this.ids.length && sessions.every((s, i) => s.id === this.ids[i]);
    if (!sameIds) this.ids = sessions.map((s) => s.id);
    let next: SessionShell[] | null = sessions.length === this.shells.length ? null : [];
    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i];
      const previous = this.shells[i]?.id === session.id ? this.shells[i] : undefined;
      const shell = shellOf(session, previous);
      if (!next && shell !== previous) next = this.shells.slice(0, i);
      if (next) next.push(shell);
    }
    if (next) this.shells = next;
  }

  private buildSnapshot(): Session[] {
    const next: Session[] = [];
    for (const id of this.openOrder) {
      const entry = this.entries.get(id);
      if (entry) next.push(entry.session);
    }
    return next;
  }

  private bump(): void {
    if (this.notifyPending != null) {
      // A sync bump supersedes the scheduled one; the flush sees null and skips.
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.notifyPending);
      else clearTimeout(this.notifyPending);
      this.notifyPending = null;
    }
    this.version += 1;
    this.snapshot = this.buildSnapshot();
    this.refreshProjections();
    for (const listener of this.listeners) listener();
    if (this.metaPending) this.bumpMeta();
    for (const [id, waiters] of this.idleWaiters) {
      const entry = this.entries.get(id);
      if (!entry || !entry.session.busy) {
        this.idleWaiters.delete(id);
        for (const resolve of waiters) resolve();
      }
    }
  }
}

export const sessionStore = new SessionStore();

/** The open sessions as React state; re-renders on any store change. */
export function useServerSessions(): Session[] {
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot);
}

/** Open session ids as React state; the same array until the set or order changes. */
export function useSessionIds(): readonly string[] {
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.getIds);
}

/** Open sessions' shells as React state; unchanged through streamed turns. */
export function useSessionShells(): SessionShell[] {
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.getShells);
}

/** One open session as React state; re-renders only when that session changes. */
export function useSession(id: string | null | undefined): Session | undefined {
  return useSyncExternalStore(sessionStore.subscribe, () =>
    id ? sessionStore.get(id) : undefined,
  );
}

/** One session's server status ("idle" for a draft); re-renders on that value alone. */
export function useSessionStatus(id: string | null | undefined): SessionStatus | undefined {
  return useSyncExternalStore(sessionStore.subscribe, () => {
    if (!id) return undefined;
    const session = sessionStore.get(id);
    if (!session) return undefined;
    return session.status ?? (session.busy ? "running" : "idle");
  });
}

/** Whether one session has a turn in flight. */
export function useSessionBusy(id: string | null | undefined): boolean {
  return useSyncExternalStore(sessionStore.subscribe, () =>
    id ? !!sessionStore.get(id)?.busy : false,
  );
}

const readMetas = (): SessionMeta[] => sessionStore.metas();
const subscribeMetas = (l: () => void): (() => void) => sessionStore.onMetaChange(l);

/** Every server-known meta as React state, open or not. */
export function useSessionMetas(): SessionMeta[] {
  return useSyncExternalStore(subscribeMetas, readMetas);
}

const NO_METAS: SessionMeta[] = [];

/** Every meta while `enabled`, else a constant empty list that never re-renders. */
export function useSessionMetasWhen(enabled: boolean): SessionMeta[] {
  return useSyncExternalStore(subscribeMetas, enabled ? readMetas : () => NO_METAS);
}

/** One session's server meta as React state; null for a draft or unknown id. */
export function useSessionMeta(id: string | null | undefined): SessionMeta | null {
  return useSyncExternalStore(subscribeMetas, () => (id ? sessionStore.metaOf(id) : null));
}

const subscribeLiveEdits = (l: () => void): (() => void) => sessionStore.onLiveEdit(l);

/** A session's live disk edits as React state. */
export function useLiveEdits(sessionId: string): Record<string, LiveEditState> {
  return useSyncExternalStore(subscribeLiveEdits, () => sessionStore.liveEditsOf(sessionId));
}

const subscribeQueues = (l: () => void): (() => void) => sessionStore.onQueueChange(l);

/** A session's queued messages as React state; `[]` until the server lists them. */
export function useQueue(sessionId: string): QueuedMessage[] {
  return useSyncExternalStore(subscribeQueues, () => sessionStore.queueOf(sessionId));
}
