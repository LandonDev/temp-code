import { nativeModelId } from "../models";
import type { Attachment, Block, RuntimeMode, Session } from "../session";
import { policyForMode } from "./access";
import { client } from "./client";
import { sessionStore } from "./store";
import { workspaceByPath, workspaceStore } from "./workspaces";
import type {
  AgentType,
  CreateSessionInput,
  PermissionPolicy,
  QueuedMessage,
  ServerAttachment,
  SessionBatchResult,
  SessionMeta,
  ThreadType,
} from "./types";

/**
 * Every session action the UI takes, as one call each onto the server.
 * `send` is the only one with shape: a draft is created on the server
 * with the id the UI already minted, and provider/model/reasoning ride
 * along only when they differ from what the server has (that is how a
 * model switch or a cross-harness handoff happens).
 */

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

/** Files by path; pasted bytes are saved server-side first. */
export async function toServerAttachments(
  attachments: Attachment[],
  link = client,
): Promise<ServerAttachment[]> {
  const out = await Promise.all(
    attachments.map(async (a): Promise<ServerAttachment | null> => {
      const kind = a.kind === "image" ? "image" : "file";
      if (a.path) {
        return { path: a.path, name: a.name, kind, ...(a.mimeType ? { mime: a.mimeType } : {}) };
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
export async function ensureCreated(session: Session, link = client): Promise<SessionMeta> {
  const existing = sessionStore.metaOf(session.id);
  if (existing) return existing;
  const meta = await link.request<SessionMeta>("session.create", {
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
  sessionStore.adopt(meta);
  if (session.modelSettings.fast === "true") {
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
  link = client,
): Promise<void> {
  sessionStore.appendOptimisticUser(
    session.id,
    display?.text ?? text,
    display?.attachments ?? attachments,
    extra,
    extra?.newPass,
  );
  const files = [...(await toServerAttachments(attachments, link)), ...(extra?.attachments ?? [])];
  const meta = await ensureCreated(session, link);
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
  });
  await sessionStore.waitIdle(session.id);
}

/** Follow-up into a running turn (front of the queue where the harness cannot steer). */
export async function steer(
  session: Session,
  text: string,
  attachments: Attachment[] = [],
  extra?: UserTurnExtra,
  display?: UserTurnDisplay,
  link = client,
): Promise<void> {
  sessionStore.appendOptimisticUser(
    session.id,
    display?.text ?? text,
    display?.attachments ?? attachments,
    extra,
  );
  const files = [...(await toServerAttachments(attachments, link)), ...(extra?.attachments ?? [])];
  const item = await queueAdd(session.id, text, files, link);
  await queueSteer(session.id, item.id, link);
}

// ── queue ────────────────────────────────────────────────────────────
// The server owns the list and pushes it whole after every change; these
// return once the RPC lands and let the push update the store.

export async function queueList(sessionId: string, link = client): Promise<QueuedMessage[]> {
  if (sessionStore.isDraft(sessionId)) return [];
  const items = await link.request<QueuedMessage[]>("queue.list", { sessionId });
  sessionStore.setQueue(sessionId, items);
  return items;
}

export async function queueAdd(
  sessionId: string,
  text: string,
  attachments: ServerAttachment[] = [],
  link = client,
): Promise<QueuedMessage> {
  const item = await link.request<QueuedMessage | null>("queue.add", {
    sessionId,
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
  });
  if (item) return item;
  // A server that answers null already pushed the list; the item is its
  // newest row with this text.
  const queued = sessionStore.queueOf(sessionId);
  for (let i = queued.length - 1; i >= 0; i -= 1) {
    if (queued[i].text === text) return queued[i];
  }
  throw new Error("The server did not queue the message");
}

export async function queueRemove(sessionId: string, messageId: string, link = client): Promise<void> {
  await link.request("queue.remove", { sessionId, messageId });
}

export async function queueUpdate(
  sessionId: string,
  messageId: string,
  text: string,
  link = client,
): Promise<void> {
  await link.request("queue.update", { sessionId, messageId, text });
}

/** Optimistic: the strip keeps the dragged order while the RPC is in flight. */
export async function queueReorder(sessionId: string, order: string[], link = client): Promise<void> {
  const byId = new Map(sessionStore.queueOf(sessionId).map((m) => [m.id, m]));
  const next = order.map((id) => byId.get(id)).filter((m): m is QueuedMessage => !!m);
  for (const m of byId.values()) if (!order.includes(m.id)) next.push(m);
  sessionStore.setQueue(sessionId, next);
  await link.request("queue.reorder", { sessionId, order });
}

/** Send a queued item into the running turn now (front-queued where the harness cannot steer). */
export async function queueSteer(sessionId: string, messageId: string, link = client): Promise<void> {
  await link.request("queue.steer", { sessionId, messageId });
}

// ── batch recovery ───────────────────────────────────────────────────

export function resumeAllPaused(link = client): Promise<SessionBatchResult> {
  return link.request<SessionBatchResult>("session.resumeAllPaused");
}

export function continueAllErrors(link = client): Promise<SessionBatchResult> {
  return link.request<SessionBatchResult>("session.continueAllErrors");
}

/** Retry one errored thread's last turn. */
export async function continueSession(sessionId: string, link = client): Promise<void> {
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.continue", { sessionId });
}

export async function interrupt(sessionId: string, link = client): Promise<void> {
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.interrupt", { sessionId });
}

export async function pause(sessionId: string, link = client): Promise<void> {
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.pause", { sessionId });
}

export async function resume(sessionId: string, link = client): Promise<void> {
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.resume", { sessionId });
}

/** Change a thread's type. A draft just takes the new type; a created
 *  thread asks the server, which re-instructs the harness on the next send. */
export async function retype(sessionId: string, threadType: ThreadType, link = client): Promise<void> {
  sessionStore.patch(sessionId, { threadType });
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.retype", { sessionId, threadType });
}

/** A plan or report file, jailed to project trees; null until written. */
export async function readFile(path: string, link = client): Promise<string | null> {
  try {
    return await link.request<string | null>("file.read", { path });
  } catch {
    return null;
  }
}

export type StartThreadParams = {
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
};

/** Create a whole thread server-side and send its kickoff brief. The
 *  `session` push (or the adopt here, whichever lands first) raises
 *  `onSessionAdded`, which is how the UI opens a tab for it. */
export async function startThread(
  params: StartThreadParams,
  brief: string,
  link = client,
): Promise<SessionMeta> {
  const meta = await link.request<SessionMeta>("session.create", {
    ...params,
    agentType: agentTypeFor(params.threadType),
  });
  sessionStore.adopt(meta);
  await link.request("session.send", { sessionId: meta.id, text: brief });
  return meta;
}

export async function approve(
  sessionId: string,
  requestId: string | number,
  allow: boolean,
  link = client,
): Promise<void> {
  await link.request("session.approve", { sessionId, requestId: String(requestId), allow });
}

export async function answer(
  sessionId: string,
  requestId: string,
  answers: string[][] | null,
  link = client,
): Promise<void> {
  await link.request("session.answer", { sessionId, requestId, answers });
}

export async function permission(sessionId: string, mode: RuntimeMode, link = client): Promise<void> {
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.permission", { sessionId, permission: policyForMode(mode) });
}

export async function tune(
  sessionId: string,
  patch: { fast?: boolean; context1m?: boolean },
  link = client,
): Promise<void> {
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.tune", { sessionId, ...patch });
}

export async function rename(sessionId: string, title: string, link = client): Promise<void> {
  sessionStore.patch(sessionId, { title });
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.rename", { sessionId, title: title.trim().slice(0, 120) });
}

export async function archive(sessionId: string, archived: boolean, link = client): Promise<void> {
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.archive", { sessionId, archived });
}

export async function pin(sessionId: string, pinned: boolean, link = client): Promise<void> {
  if (sessionStore.isDraft(sessionId)) return;
  await link.request("session.pin", { sessionId, pinned });
}

export async function remove(sessionId: string, link = client): Promise<void> {
  if (sessionStore.isDraft(sessionId)) {
    sessionStore.mutate((prev) => prev.filter((s) => s.id !== sessionId));
    return;
  }
  await link.request("session.delete", { sessionId });
}
