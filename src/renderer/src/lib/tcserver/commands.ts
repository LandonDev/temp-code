import { nativeModelId } from "../models";
import { bridgeNewThread } from "../macBridge";
import type { Attachment, Block, RuntimeMode, Session } from "../session";
import { policyForMode } from "./access";
import { needsUpload, uploadAttachment } from "../attachmentUpload";
import { registry, type Link } from "../connection";
import { sessionStore } from "./store";
import { workspaceByPath, workspaceStore } from "./workspaces";
import type {
  AgentType,
  CreateSessionInput,
  PermissionPolicy,
  QueuedMessage,
  QueueAddResult,
  ServerAttachment,
  SessionBatchResult,
  TaskLog,
  SessionMeta,
  WireSessionMeta,
  ThreadRules,
  ThreadType,
} from "./types";

/**
 * Every session action the UI takes, as one call each onto the server.
 * `send` is the only one with shape: a draft is created on the server
 * with the id the UI already minted, and provider/model/reasoning ride
 * along only when they differ from what the server has (that is how a
 * model switch or a cross-harness handoff happens).
 */

/** A person's click: the host runs it ahead of its polls (src/main/server/lane.ts). */
const UI = { lane: "ui" } as const;

export type UserTurnExtra = {
  secondOpinion?: Block["secondOpinion"];
  noteCard?: Block["noteCard"];
  /** Attachments implied by the text (`@path`, `@thread:<id>`): sent, never shown. */
  attachments?: ServerAttachment[];
  /** The board's "Start pass N" button: this message opens a new round. */
  newPass?: boolean;
};

export function agentTypeFor(threadType: ThreadType | null | undefined): AgentType {
  return threadType === "orchestration" ? "orchestrator" : "implementer";
}

/** What the optimistic user bubble shows when it differs from what is sent
 *  (prepared prompts expand mentions; the bubble keeps the typed text). */
export type UserTurnDisplay = { text?: string; attachments?: Attachment[] };

const REASONING = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

/** The server's effort ladder from MonoCode's per-model setting. */
export function reasoningOf(session: Pick<Session, "modelSettings">): string | undefined {
  const effort = session.modelSettings.effort ?? session.modelSettings.reasoningEffort;
  if (!effort) return undefined;
  if (REASONING.has(effort)) return effort;
  if (effort === "ultrathink" || effort === "ultracode") return "max";
  return undefined;
}

function serverCwd(cwd: string): string | undefined {
  return cwd && cwd !== "~" ? cwd : undefined;
}

/** The link of a session the store knows; a draft's is the environment it was minted for. */
function linkOfSession(session: Pick<Session, "id" | "environmentId">): Link {
  return sessionStore.linkFor(session.id) ?? registry.linkOf(session.environmentId);
}

/** The link a known session's requests ride on. */
function linkFor(sessionId: string): Link {
  const link = sessionStore.linkFor(sessionId);
  if (!link) throw new Error(`unknown session: ${sessionId}`);
  return link;
}

/** Files by path; pasted bytes are saved server-side first. A file that
 *  lives on another host than `environmentId` (or only in memory) is
 *  uploaded to the thread first when `sessionId` names it: the composer
 *  does that itself with progress, this is the fallback for every other
 *  caller, so a path on the wrong host never reaches the turn. */
export async function toServerAttachments(
  environmentId: string,
  attachments: Attachment[],
  sessionId?: string,
): Promise<ServerAttachment[]> {
  const link = registry.linkOf(environmentId);
  const out = await Promise.all(
    attachments.map(async (original): Promise<ServerAttachment | null> => {
      const a =
        sessionId && needsUpload(original, environmentId)
          ? await uploadAttachment(environmentId, sessionId, original)
          : original;
      const kind = a.kind === "image" ? "image" : "file";
      if (a.path) {
        const mime = a.mimeType ? { mime: a.mimeType } : {};
        // An appshot rides as one attachment; the server splits it into the
        // image and its text before the driver sees it.
        if (a.textPath) return { path: a.path, name: a.name, kind: "appshot", textPath: a.textPath, ...mime };
        return { path: a.path, name: a.name, kind, ...mime };
      }
      if (a.data) {
        const dataBase64 = a.data.includes(",") ? a.data.slice(a.data.indexOf(",") + 1) : a.data;
        return link.request<ServerAttachment>("attachment.save", { name: a.name, dataBase64 });
      }
      return null;
    }),
  );
  return out.filter((a): a is ServerAttachment => a !== null);
}

/** Create the draft on the server if needed; returns its meta. */
export async function ensureCreated(session: Session): Promise<SessionMeta> {
  const existing = sessionStore.metaOf(session.id);
  if (existing) return existing;
  const link = linkOfSession(session);
  const wire = await link.request<WireSessionMeta>("session.create", {
    id: session.id,
    provider: session.harness,
    model: nativeModelId(session.model),
    reasoning: reasoningOf(session),
    cwd: serverCwd(session.worktreeCwd || session.cwd),
    permission: policyForMode(session.runtimeMode),
    context1m: session.modelSettings.context === "1m",
    threadType: session.threadType ?? "chat",
    agentType: agentTypeFor(session.threadType),
    ...(session.planPath ? { planPath: session.planPath } : {}),
    ...(session.threadRules ? { threadRules: session.threadRules } : {}),
    projectId: session.projectId ?? null,
    // A draft minted before the catalog loaded still lands in its folder's workspace.
    workspaceId:
      session.workspaceId ??
      (session.projectId
        ? null
        : (workspaceByPath(workspaceStore.workspaces, session.cwd)?.id ?? null)),
  });
  const meta: SessionMeta = { ...wire, environmentId: link.environmentId };
  sessionStore.adopt(meta);
  // A thread made on another host gets this Mac's bridge when this Mac's policy for that host allows it (lib/macBridge.ts).
  await bridgeNewThread(link.environmentId, session.id);
  if (session.modelSettings.ultrafast === "true") {
    await link.request("session.tune", { sessionId: session.id, ultrafast: true });
  } else if (session.modelSettings.fast === "true") {
    await link.request("session.tune", { sessionId: session.id, fast: true });
  }
  return meta;
}

/** Send a turn; resolves when the turn has settled. */
export async function send(
  session: Session,
  text: string,
  attachments: Attachment[] = [],
  extra?: UserTurnExtra,
  display?: UserTurnDisplay,
): Promise<void> {
  sessionStore.appendOptimisticUser(
    session.id,
    display?.text ?? text,
    display?.attachments ?? attachments,
    extra,
    extra?.newPass,
  );
  const link = linkOfSession(session);
  const files = [...(await toServerAttachments(link.environmentId, attachments, session.id)), ...(extra?.attachments ?? [])];
  const meta = await ensureCreated(session);
  const model = nativeModelId(session.model);
  const reasoning = reasoningOf(session);
  await link.request("session.send", {
    sessionId: session.id,
    text,
    ...(extra?.newPass ? { newPass: true } : {}),
    ...(files.length > 0 ? { attachments: files } : {}),
    ...(session.harness !== meta.provider ? { provider: session.harness } : {}),
    ...(model !== meta.model ? { model } : {}),
    ...(reasoning && reasoning !== meta.reasoning ? { reasoning } : {}),
  }, UI);
  await sessionStore.waitIdle(session.id);
}

/** Follow-up into a running turn (front of the queue where the harness cannot steer). */
export async function steer(
  session: Session,
  text: string,
  attachments: Attachment[] = [],
  extra?: UserTurnExtra,
  display?: UserTurnDisplay,
): Promise<void> {
  sessionStore.appendOptimisticUser(
    session.id,
    display?.text ?? text,
    display?.attachments ?? attachments,
    extra,
  );
  const files = [...(await toServerAttachments(session.environmentId, attachments, session.id)), ...(extra?.attachments ?? [])];
  // The host steers a live turn itself (sessions.ts steerLive); a message it
  // queued instead (attachments, an older host) is sent into the turn now.
  const added = await queueAdd(session.id, text, files, runSettingsFor(session), true);
  if (added.kind === "queued") await queueSteer(session.id, added.item.id);
}

/** Run settings a queued message carries to its eventual send: the
 *  composer's provider/model/effort, where they differ from the server's. */
export type QueueRunSettings = { provider?: string; model?: string; reasoning?: string };

export function runSettingsFor(session: Session): QueueRunSettings {
  const meta = sessionStore.metaOf(session.id);
  const model = nativeModelId(session.model);
  const reasoning = reasoningOf(session);
  return {
    ...(!meta || session.harness !== meta.provider ? { provider: session.harness } : {}),
    ...(!meta || model !== meta.model ? { model } : {}),
    ...(reasoning && (!meta || reasoning !== meta.reasoning) ? { reasoning } : {}),
  };
}

// ── queue ────────────────────────────────────────────────────────────
// The server owns the list and pushes it whole after every change; these
// return once the RPC lands and let the push update the store.

export async function queueList(sessionId: string): Promise<QueuedMessage[]> {
  const link = linkFor(sessionId);
  if (sessionStore.isDraft(sessionId)) return [];
  const items = await link.request<QueuedMessage[]>("queue.list", { sessionId });
  sessionStore.setQueue(sessionId, items);
  return items;
}

/** Queue a message, or with `steer` send it into the live turn. The host's
 *  typed answer says which happened; an older host answered the item or
 *  null (its pushed list then holds the newest row with this text). */
export async function queueAdd(
  sessionId: string,
  text: string,
  attachments: ServerAttachment[] = [],
  settings: QueueRunSettings = {},
  steer = false,
): Promise<QueueAddResult> {
  const link = linkFor(sessionId);
  const answer = await link.request<QueueAddResult | QueuedMessage | null>("queue.add", {
    sessionId,
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...settings,
    ...(steer ? { steer: true } : {}),
  });
  if (answer && "kind" in answer) return answer;
  if (answer) return { kind: "queued", item: answer };
  const queued = sessionStore.queueOf(sessionId);
  for (let i = queued.length - 1; i >= 0; i -= 1) {
    if (queued[i].text === text) return { kind: "queued", item: queued[i] };
  }
  throw new Error("The server did not queue the message");
}

export async function queueRemove(sessionId: string, messageId: string): Promise<void> {
  const link = linkFor(sessionId);
  await link.request("queue.remove", { sessionId, messageId });
}

export async function queueUpdate(
  sessionId: string,
  messageId: string,
  text: string,
): Promise<void> {
  const link = linkFor(sessionId);
  await link.request("queue.update", { sessionId, messageId, text });
}

/** Per-message run settings; null clears one so the message follows the thread. */
export type QueueTune = { [K in keyof QueueRunSettings]?: QueueRunSettings[K] | null };

export async function queueTune(
  sessionId: string,
  messageId: string,
  settings: QueueTune,
): Promise<void> {
  const link = linkFor(sessionId);
  await link.request("queue.update", { sessionId, messageId, ...settings });
}

/** Optimistic: the strip keeps the dragged order while the RPC is in flight. */
export async function queueReorder(sessionId: string, order: string[]): Promise<void> {
  const link = linkFor(sessionId);
  const byId = new Map(sessionStore.queueOf(sessionId).map((m) => [m.id, m]));
  const next = order.map((id) => byId.get(id)).filter((m): m is QueuedMessage => !!m);
  for (const m of byId.values()) if (!order.includes(m.id)) next.push(m);
  sessionStore.setQueue(sessionId, next);
  await link.request("queue.reorder", { sessionId, order });
}

/** Send a queued item into the running turn now (front-queued where the harness cannot steer). */
export async function queueSteer(sessionId: string, messageId: string): Promise<void> {
  const link = linkFor(sessionId);
  await link.request("queue.steer", { sessionId, messageId });
}

// ── focus ────────────────────────────────────────────────────────────

type FocusLink = Pick<Link, "connected" | "request">;

/** A send that failed: the host may hold the focus or not, so the next change is sent whatever it is. */
const UNKNOWN = Symbol("unknown focus");

/**
 * `session.focus`: the thread this window's focused pane shows goes to its
 * host, null to every other host and to all of them while the window is
 * not focused; the host runs that thread's requests and pushes first
 * (src/main/server/focus.ts). Sent once per change per link, the changes
 * of one commit folded into one (a pane's cleanup and the next pane's
 * effect), and again when a link opens a new socket.
 */
export class FocusSignal {
  private active: { environmentId: string; sessionId: string } | null = null;
  private windowFocused = true;
  /** What each link's socket was last told; absent: nothing since it opened. */
  private sent = new Map<string, string | null | typeof UNKNOWN>();
  private queued = false;

  constructor(
    private readonly linkOf: (environmentId: string) => FocusLink | undefined,
    // Wrapped: called as `this.defer(…)`, the bare global throws "Illegal invocation".
    private readonly defer: (fn: () => void) => void = (fn) => queueMicrotask(fn),
  ) {}

  /** The focused, visible pane shows this thread. */
  pane(environmentId: string, sessionId: string): void {
    this.active = { environmentId, sessionId };
    this.schedule();
  }

  /** The pane that showed this thread lost focus or closed. */
  left(sessionId: string): void {
    if (this.active?.sessionId !== sessionId) return;
    this.active = null;
    this.schedule();
  }

  window(focused: boolean): void {
    if (this.windowFocused === focused) return;
    this.windowFocused = focused;
    this.schedule();
  }

  /** The link opened a new socket, which holds no focus yet. */
  reopened(environmentId: string): void {
    this.sent.delete(environmentId);
    this.schedule();
  }

  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    this.defer(() => {
      this.queued = false;
      this.flush();
    });
  }

  private flush(): void {
    const want = this.windowFocused ? this.active : null;
    const hosts = new Set(this.sent.keys());
    if (want) hosts.add(want.environmentId);
    for (const environmentId of hosts) {
      const next = want?.environmentId === environmentId ? want.sessionId : null;
      if (this.sent.has(environmentId) ? this.sent.get(environmentId) === next : next === null) continue;
      const link = this.linkOf(environmentId);
      if (!link?.connected) {
        // Told again when it opens.
        this.sent.delete(environmentId);
        continue;
      }
      this.sent.set(environmentId, next);
      void link.request("session.focus", { sessionId: next }, { retry: false }).catch(() => {
        // It may have landed (a late answer) or not: the next change goes to this host either way.
        if (this.sent.get(environmentId) === next) this.sent.set(environmentId, UNKNOWN);
      });
    }
  }
}

export const focusSignal = new FocusSignal((environmentId) => registry.link(environmentId));

// ── batch recovery ───────────────────────────────────────────────────

/** The composer of an idle thread gained focus: the host opens the socket its next turn will ride (one per account per minute). */
export function preconnect(sessionId: string): Promise<boolean> {
  return linkFor(sessionId).request<boolean>("session.preconnect", { sessionId });
}

export function resumeAllPaused(environmentId: string): Promise<SessionBatchResult> {
  return registry.linkOf(environmentId).request<SessionBatchResult>("session.resumeAllPaused");
}

export function continueAllErrors(environmentId: string): Promise<SessionBatchResult> {
  return registry.linkOf(environmentId).request<SessionBatchResult>("session.continueAllErrors");
}

/** Retry one errored thread's last turn, optionally on another model or
 *  effort (every restarted thread in its tree switches first). */
/** The failure card's Route automatically: the thread re-picks its account
 *  fresh and respawns there on the next send. `moved` says it landed somewhere new. */
export async function rerouteSession(sessionId: string): Promise<{ account: string | null; moved: boolean }> {
  const link = linkFor(sessionId);
  if (sessionStore.isDraft(sessionId)) return { account: null, moved: false };
  return link.request("session.reroute", { sessionId });
}

/** Merge past a held merge review ("Merge anyway" on the review card). */
export async function mergeAnyway(sessionId: string, runId: string): Promise<void> {
  const link = linkFor(sessionId);
  await link.request("review.override", { sessionId, runId });
}

export async function continueSession(
  sessionId: string,
  run: QueueRunSettings = {},
): Promise<void> {
  const link = linkFor(sessionId);
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.continue", { sessionId, ...run });
}

export async function interrupt(sessionId: string): Promise<void> {
  const link = linkFor(sessionId);
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.interrupt", { sessionId }, UI);
}

/** Pause every running thread at once. */
export function pauseAllRunning(environmentId: string): Promise<SessionBatchResult> {
  return registry.linkOf(environmentId).request<SessionBatchResult>("session.pauseAllRunning");
}

export type SessionBatchAction = "pause" | "resume" | "stop" | "archive";

/** One action over the given threads on one host, four at a time, each id
 *  answered (lib/threadBatch.ts picks the ids). `cleanup` asks an archive
 *  to release each thread's worktree and devices too. */
export function sessionBatch(
  environmentId: string,
  action: SessionBatchAction,
  ids: readonly string[],
  options: { cleanup?: boolean } = {},
): Promise<SessionBatchResult> {
  return registry.linkOf(environmentId).request<SessionBatchResult>(
    "session.batch",
    { action, ids: [...ids], ...(options.cleanup ? { cleanup: true } : {}) },
    UI,
  );
}

/** Context-window breakdown for one thread, as the harness reports it
 *  (claude's /context data); null while it streams or has no accounting. */
export async function context(sessionId: string): Promise<unknown> {
  const link = linkFor(sessionId);
  if (sessionStore.isDraft(sessionId)) return null;
  return link.request<unknown>("session.context", { sessionId });
}

/** Compact the conversation in place; progress arrives as compaction events. */
export async function compact(sessionId: string): Promise<void> {
  const link = linkFor(sessionId);
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.compact", { sessionId });
}

/** Kill the background tasks a watching thread waits on; the row settles idle. */
export async function killBackground(sessionId: string): Promise<void> {
  const link = linkFor(sessionId);
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.killBackground", { sessionId });
}

/** Stop one background task of a live thread (the Activity section's Stop). */
export async function stopTask(sessionId: string, taskId: string): Promise<void> {
  const link = linkFor(sessionId);
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.stopTask", { sessionId, taskId }, UI);
}

/** One background task's output from `from` on (the Activity section's log fold). */
export async function taskLog(sessionId: string, taskId: string, from?: number): Promise<TaskLog> {
  const link = linkFor(sessionId);
  return link.request<TaskLog>("session.taskLog", { sessionId, taskId, ...(from === undefined ? {} : { from }) });
}

export async function setGoal(sessionId: string, condition: string): Promise<void> {
  const link = linkFor(sessionId);
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.setGoal", { sessionId, condition });
}

export async function clearGoal(sessionId: string): Promise<void> {
  const link = linkFor(sessionId);
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.clearGoal", { sessionId });
}

export async function setThreadRules(
  sessionId: string,
  threadRules: ThreadRules | null,
): Promise<void> {
  const link = linkFor(sessionId);
  // A draft keeps them locally; ensureCreated sends them with the create.
  if (sessionStore.isDraft(sessionId)) {
    sessionStore.patch(sessionId, { threadRules });
    return;
  }
  await link.request("session.setThreadRules", { sessionId, threadRules });
}

/** Data URL for an image the server holds (history attachments). */
export function readAttachment(environmentId: string, path: string): Promise<string> {
  return registry.linkOf(environmentId).request<string>("attachment.read", { path });
}

export async function pause(sessionId: string): Promise<void> {
  const link = linkFor(sessionId);
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.pause", { sessionId }, UI);
}

export async function resume(sessionId: string): Promise<void> {
  const link = linkFor(sessionId);
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.resume", { sessionId }, UI);
}

/** Start a queued thread now, past the host's cap and its `after` (the strip's Start now). */
export async function startNow(sessionId: string): Promise<void> {
  const link = linkFor(sessionId);
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.start", { sessionId }, UI);
}

/** Change a thread's type. A draft just takes the new type; a created
 *  thread asks the server, which re-instructs the harness on the next send. */
export async function retype(sessionId: string, threadType: ThreadType): Promise<void> {
  const link = linkFor(sessionId);
  sessionStore.patch(sessionId, { threadType });
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.retype", { sessionId, threadType });
}

/** A plan or report file, jailed to project trees; null until written. */
export async function readFile(environmentId: string, path: string): Promise<string | null> {
  try {
    return await registry.linkOf(environmentId).request<string | null>("file.read", { path });
  } catch {
    return null;
  }
}

export type StartThreadParams = {
  /** The host the thread is created on. */
  environmentId: string;
  threadType: ThreadType;
  provider: string;
  model?: string;
  reasoning?: string;
  permission?: PermissionPolicy;
  context1m?: boolean;
  projectId?: string | null;
  workspaceId?: string | null;
  cwd?: string;
  planPath?: string;
  goal?: string;
  title?: string;
  threadRules?: CreateSessionInput["threadRules"];
  /** Master threads (CLAUDE.md "Master threads"): the master this root thread joins. */
  masterId?: string;
  /** The thread that asked for this one (the master, from the board's add sheet): its settle reports there. */
  startedBy?: string;
  /** Master threads: the sibling to wait for before booting. */
  after?: string;
  /** Queue behind the host's cap and `after` instead of booting at once (scheduler.ts). */
  queue?: boolean;
};

/** Create a whole thread server-side and send its kickoff brief. The
 *  `session` push (or the adopt here, whichever lands first) raises
 *  `onSessionAdded`, and the UI gives it a tab behind the user's work. */
export async function startThread(params: StartThreadParams, brief: string): Promise<SessionMeta> {
  const { environmentId, ...create } = params;
  const link = registry.linkOf(environmentId);
  const wire = await link.request<WireSessionMeta>("session.create", {
    ...create,
    agentType: agentTypeFor(params.threadType),
  });
  const meta: SessionMeta = { ...wire, environmentId };
  sessionStore.adopt(meta);
  await bridgeNewThread(environmentId, meta.id);
  await link.request("session.send", { sessionId: meta.id, text: brief }, UI);
  return meta;
}

export async function approve(
  sessionId: string,
  requestId: string | number,
  allow: boolean,
): Promise<void> {
  const link = linkFor(sessionId);
  await link.request("session.approve", { sessionId, requestId: String(requestId), allow }, UI);
}

export async function answer(
  sessionId: string,
  requestId: string,
  answers: string[][] | null,
): Promise<void> {
  const link = linkFor(sessionId);
  await link.request("session.answer", { sessionId, requestId, answers }, UI);
}

export async function permission(sessionId: string, mode: RuntimeMode): Promise<void> {
  const link = linkFor(sessionId);
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.permission", { sessionId, permission: policyForMode(mode) });
}

export async function tune(
  sessionId: string,
  patch: { fast?: boolean; ultrafast?: boolean; context1m?: boolean; model?: string },
): Promise<void> {
  const link = linkFor(sessionId);
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.tune", { sessionId, ...patch });
}

export async function rename(sessionId: string, title: string): Promise<void> {
  const link = linkFor(sessionId);
  sessionStore.patch(sessionId, { title });
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.rename", { sessionId, title: title.trim().slice(0, 120) });
}

export async function archive(sessionId: string, archived: boolean): Promise<void> {
  const link = linkFor(sessionId);
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.archive", { sessionId, archived }, UI);
}

/** Make a root thread a master, or stop it being one (CLAUDE.md "Master threads"). */
export async function setMaster(sessionId: string, master: boolean): Promise<void> {
  const link = linkFor(sessionId);
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.setMaster", { sessionId, master });
}

export async function pin(sessionId: string, pinned: boolean): Promise<void> {
  const link = linkFor(sessionId);
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.pin", { sessionId, pinned });
}

export async function remove(sessionId: string): Promise<void> {
  const link = linkFor(sessionId);
  if (sessionStore.isDraft(sessionId)) {
    sessionStore.mutate((prev) => prev.filter((s) => s.id !== sessionId));
    return;
  }
  await link.request("session.delete", { sessionId });
}
