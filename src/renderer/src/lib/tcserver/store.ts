import { useSyncExternalStore } from "react";
import type { Attachment, Block, HarnessId, Session } from "../session";
import { HARNESSES } from "../session";
import { resolveModel } from "../models";
import { client } from "./client";
import { modeForPolicy } from "./access";
import { emptyFold, foldEvent, foldOptimisticUser, type FoldState } from "./fold";
import { emptyThread } from "./todos";
import type { EventRow, QueuedMessage, ServerPush, SessionMeta, SessionStatus } from "./types";

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

export type Link = {
  request<T>(method: string, params?: unknown): Promise<T>;
  onPush(listener: (push: ServerPush) => void): () => void;
  onOpen(listener: () => void): () => void;
  readonly connected: boolean;
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
  subscribed: boolean;
  /** Pushes held back while a history fetch is in flight; they fold after
   *  it so a live row never lands ahead of the older rows it follows. */
  held: EventRow[] | null;
  /** The part of the log before the tail that painted first: the rows
   *  before `beforeSeq` are still to come, and every row folded since the
   *  tail landed waits in `since` so the refold includes it. */
  head: Head | null;
};

type Head = {
  beforeSeq: number;
  since: EventRow[];
  fetching: boolean;
  waiters: (() => void)[];
};

/** A first load asks for this many user turns; the rest folds behind it. */
const TAIL_TURNS = 20;
/** Rows folded per slice while the head of a long log folds in the background. */
const HEAD_CHUNK = 2000;

const OPEN_STATUSES = new Set(["starting", "running", "waiting"]);
const READY_TIMEOUT_MS = 10_000;

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
  if (changed("reasoning") || changed("fast") || changed("context1m")) {
    set({
      modelSettings: {
        ...next.modelSettings,
        ...(changed("reasoning") ? { effort: meta.reasoning } : {}),
        ...(changed("fast") ? { fast: String(meta.fast) } : {}),
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
  if (changed("parentId")) set({ parentId: meta.parentId });
  if (changed("agentType")) set({ agentType: meta.agentType });
  if (changed("status")) set({ status: meta.status });
  if (changed("archived")) set({ archived: meta.archived });
  if (changed("busySince")) set({ busySince: meta.busySince });
  if (changed("pausedAt")) set({ pausedAt: meta.pausedAt });
  if (changed("frozenActiveElapsed")) set({ frozenActiveElapsed: meta.frozenActiveElapsed });
  if (changed("treeCanContinue")) set({ treeCanContinue: meta.treeCanContinue });
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
  private link: Link | null = null;
  private detach: (() => void)[] = [];
  private listed: Promise<void> | null = null;
  private opened: Promise<void> = Promise.resolve();

  /** Attach to the socket once; safe to call again with the same link. */
  connect(link: Link = client): void {
    if (this.link === link) return;
    for (const off of this.detach) off();
    this.link = link;
    let markOpen: () => void = () => {};
    this.opened = new Promise<void>((resolve) => {
      markOpen = resolve;
    });
    const list = (): void => {
      this.listed = this.resync()
        .catch(() => undefined)
        .then(() => {
          this.readyDone = true;
        });
      markOpen();
    };
    this.detach = [link.onPush((push) => this.onPush(push)), link.onOpen(list)];
    if (link.connected) list();
  }

  /** Test seam. */
  reset(): void {
    for (const off of this.detach) off();
    this.detach = [];
    this.link = null;
    this.opened = Promise.resolve();
    for (const entry of this.entries.values()) this.settleHead(entry);
    this.entries.clear();
    this.openOrder = [];
    this.queues.clear();
    this.liveEdits.clear();
    this.listed = null;
    this.readyDone = false;
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

  /** Every server-known meta (drafts excluded). */
  metas(): SessionMeta[] {
    const out: SessionMeta[] = [];
    for (const entry of this.entries.values()) if (entry.meta) out.push(entry.meta);
    return out;
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

  /** `session.list`, then replay any gap for loaded sessions. */
  async resync(): Promise<void> {
    if (!this.link) return;
    const metas = await this.link.request<SessionMeta[]>("session.list");
    const seen = new Set<string>();
    for (const meta of metas) {
      seen.add(meta.id);
      this.mergeMeta(meta);
    }
    for (const [id, entry] of this.entries) {
      if (entry.meta && !seen.has(id)) this.drop(id);
      // Subscriptions belong to the socket that made them; a new socket
      // starts with none, so every loaded session subscribes again.
      entry.subscribed = false;
    }
    this.bumpMeta();
    await Promise.all(
      [...this.entries.values()]
        .filter((entry) => entry.loaded && entry.meta)
        .map((entry) => this.replayGap(entry)),
    );
    this.bump();
  }

  /** The first `session.list` after the socket opens. Boot waits on it, but
   *  not forever: with the sidecar down the app still renders and the list
   *  fills in on connect. */
  ready(timeoutMs = READY_TIMEOUT_MS): Promise<void> {
    const listed = this.opened.then(() => this.listed ?? Promise.resolve());
    return Promise.race([listed, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
  }

  /** Fetch the transcript once and subscribe to its live pushes. */
  ensureLoaded(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || !entry.meta) return Promise.resolve();
    if (entry.loaded) return Promise.resolve();
    if (entry.loading) return entry.loading;
    entry.loading = this.replayGap(entry)
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

  /** `ensureLoaded`, then wait for the head of a tail-first load. */
  async ensureComplete(id: string): Promise<void> {
    await this.ensureLoaded(id);
    const head = this.entries.get(id)?.head;
    if (head) await new Promise<void>((resolve) => head.waiters.push(resolve));
  }

  private async replayGap(entry: Entry): Promise<void> {
    if (!this.link) return;
    const id = entry.session.id;
    if (entry.held) return;
    entry.held = [];
    // A first load paints the last turns first; the rest folds behind them.
    const tailFirst = !entry.loaded && entry.lastSeq === 0 && !entry.head;
    try {
      if (!entry.subscribed) {
        await this.link.request("session.subscribe", { sessionId: id });
        entry.subscribed = true;
      }
      const [rows] = await Promise.all([
      this.link.request<EventRow[]>("session.events", {
        sessionId: id,
        afterSeq: entry.lastSeq,
        ...(tailFirst ? { tail: TAIL_TURNS } : {}),
      }),
      // The queue lives in server memory: a restart empties it, so the
      // strip refills from the list rather than keeping stale rows.
      this.link
        .request<QueuedMessage[]>("queue.list", { sessionId: id })
        .then((items) => this.setQueue(id, items ?? []))
        .catch(() => undefined),
      ]);
      // Seqs are contiguous from 1, so a tail that starts later has a head.
      if (tailFirst && rows.length > 0 && rows[0].seq > 1) {
        entry.head = { beforeSeq: rows[0].seq, since: [], fetching: false, waiters: [] };
      }
      for (const row of rows) this.foldRow(entry, row);
    } finally {
      const held = entry.held;
      entry.held = null;
      // The fold drops whatever history already covered.
      for (const row of held ?? []) this.applyPush(entry, row);
    }
    if (entry.head && !entry.head.fetching) void this.fetchHead(entry);
  }

  /** Fetch the rows before a tail-first paint and refold the whole log
   *  from the start, in slices off the main path, then swap it in. Ids
   *  come from seqs, so the blocks the tail already showed keep theirs. */
  private async fetchHead(entry: Entry): Promise<void> {
    const head = entry.head;
    if (!head || head.fetching || !this.link) return;
    const id = entry.session.id;
    head.fetching = true;
    let rows: EventRow[];
    try {
      rows = await this.link.request<EventRow[]>("session.events", {
        sessionId: id,
        afterSeq: 0,
        beforeSeq: head.beforeSeq,
      });
    } catch {
      // The next reconnect replay tries again.
      head.fetching = false;
      return;
    }
    const live = (): boolean => this.entries.get(id) === entry && entry.head === head;
    const cwd = entry.session.cwd;
    let state = emptyFold();
    for (let i = 0; i < rows.length; i += HEAD_CHUNK) {
      if (!live()) return;
      for (const row of rows.slice(i, i + HEAD_CHUNK)) state = foldEvent(state, row, cwd);
      if (i + HEAD_CHUNK < rows.length) await new Promise((r) => setTimeout(r, 0));
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
      ...(state.context ? { context: state.context } : {}),
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

  private onPush(push: ServerPush): void {
    switch (push.push) {
      case "session": {
        const fresh = !this.entries.has(push.session.id);
        this.mergeMeta(push.session);
        this.bump();
        this.bumpMeta();
        if (fresh) this.noteAdded(push.session);
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
        const entry = this.entries.get(push.row.sessionId);
        if (entry) this.applyPush(entry, push.row);
        break;
      }
      case "session-removed":
        for (const id of push.sessionIds) this.drop(id);
        this.bump();
        this.bumpMeta();
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
    entry.lastSeq = after.lastSeq;
    entry.nextId = after.nextId;
    entry.session = {
      ...entry.session,
      blocks: after.blocks,
      busy: after.busy,
      thread: after.thread,
      ...(after.context ? { context: after.context } : {}),
    };
    return true;
  }

  private mergeMeta(meta: SessionMeta): void {
    const entry = this.entries.get(meta.id);
    if (!entry) {
      this.entries.set(meta.id, {
        session: sessionFromMeta(meta),
        meta,
        lastSeq: 0,
        nextId: 1,
        loaded: false,
        loading: null,
        subscribed: false,
        held: null,
        head: null,
      });
      return;
    }
    if (!entry.meta) {
      // Draft adoption: the server echoes what the UI sent, so the local
      // view stays; only what the server adds comes across.
      entry.session = applyThreadMeta(
        {
          ...entry.session,
          busy: entry.session.busy || isOpenStatus(meta.status),
          ...(meta.nativeId ? { providerSessionId: meta.nativeId } : {}),
        },
        null,
        meta,
      );
    } else {
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

  private drop(id: string): void {
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
          subscribed: false,
          held: null,
          head: null,
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
      if (!entry.subscribed && this.link) {
        entry.subscribed = true;
        void this.link.request("session.subscribe", { sessionId: meta.id }).catch(() => {
          entry.subscribed = false;
        });
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
    for (const listener of this.metaListeners) listener();
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

let metasCache: SessionMeta[] | null = null;
sessionStore.onMetaChange(() => {
  metasCache = null;
});
const readMetas = (): SessionMeta[] => (metasCache ??= sessionStore.metas());
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
