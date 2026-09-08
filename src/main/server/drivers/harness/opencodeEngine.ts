import type { Attachment, PermissionPolicy } from "@shared/events";
import {
  execChild,
  freeHarnessPort,
  killChild,
  resolveOpenCodeBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "./child";
import { modelContextWindow } from "./opencodeCatalog";
import { OpenCodeClient, OpenCodeHttpError, type OpenCodePromptPart } from "./opencodeClient";
import {
  appendOpenCodeAssistantTextDelta,
  asRecord,
  buildOpenCodePermissionRules,
  compareSemver,
  contextUsedFromMessageInfo,
  detailFromToolPart,
  eventSessionId,
  isOpenCodeNotFound,
  mergeOpenCodeAssistantText,
  MINIMUM_OPENCODE_VERSION,
  parseOpenCodeModelSlug,
  parseOpenCodeQuestions,
  parseOpenCodeVersion,
  parseServerUrlFromOutput,
  permissionTitle,
  previewFromToolPart,
  sessionErrorMessage,
  stringField,
  textDeltaEvent,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toolKindFromName,
  type OpenCodePart,
  type OpenCodeQuestion,
} from "./opencodeProtocol";
import { composeToolTitle, extractShellCommand, extractSkillName } from "./preview";
import { streamTextDelta } from "./streamText";
import type { ApprovalDecision, HarnessEvent } from "./types";

/**
 * One `opencode serve` per session, driven over HTTP + SSE. Ported from
 * src/lib/harness/opencode.ts; what changed: the per-thread registries
 * became one engine object per driver handle, the replay buffer and pid
 * guard went (the bridge owns the child), and questions leave through
 * their own callback because HarnessEvent has no question variant.
 */

export type OpenCodeQuestionRequest = {
  id: string;
  questions: OpenCodeQuestion[];
  callId?: string;
};

export type OpenCodeEngineOptions = {
  sessionId: string;
  cwd: string;
  permission: PermissionPolicy;
  /** opencode session id to adopt (forked when its directory differs). */
  resumeId?: string | null;
  onEvent: (event: HarnessEvent) => void;
  onQuestion: (request: OpenCodeQuestionRequest) => void;
};

export type OpenCodeTurn = {
  /** Native `provider/model` id. */
  model: string;
  variant?: string;
  text: string;
  attachments?: Attachment[];
};

export interface OpenCodeEngine {
  start: () => Promise<void>;
  /** Runs a turn to completion; a send during a turn steers it and
   *  returns once the prompt is queued. */
  sendTurn: (turn: OpenCodeTurn) => Promise<void>;
  respondApproval: (requestId: number, decision: ApprovalDecision) => boolean;
  /** null = the user declined to answer. */
  answerQuestion: (id: string, answers: string[][] | null) => Promise<void>;
  cancelTurn: () => Promise<void>;
  stop: () => Promise<void>;
}

type PendingApproval = { id: string; resolve: (decision: ApprovalDecision) => void };

const SERVER_TIMEOUT_MS = 30_000;

export function createOpenCodeEngine(opts: OpenCodeEngineOptions): OpenCodeEngine {
  const { sessionId, cwd, onEvent, onQuestion } = opts;

  let client: OpenCodeClient | null = null;
  let openCodeSessionId = "";
  let serverExited: number | null | undefined;
  let stopped = false;
  const approvals = new Map<number, PendingApproval>();
  let nextApprovalUiId = 1;
  const openQuestions = new Set<string>();
  const partById = new Map<string, OpenCodePart>();
  const emittedTextByPartId = new Map<string, string>();
  const messageRoleById = new Map<string, "user" | "assistant">();
  let cancelled = false;
  let muteUpdates = false;
  let turns: Promise<void> = Promise.resolve();
  let turnDone: (() => void) | null = null;
  let turnFailed: ((error: Error) => void) | null = null;
  let turnEndPending = false;
  let activeTurn = false;

  const live = (): OpenCodeClient => {
    if (!client || stopped) throw new Error("opencode harness gone");
    if (serverExited !== undefined) throw new Error("opencode harness gone: server exited");
    return client;
  };

  async function start(): Promise<void> {
    const { path } = await resolveOpenCodeBinary();
    await assertOpenCodeVersion(path, cwd);

    let serverUrl = "";
    const scrape = (line: string): void => {
      const parsed = parseServerUrlFromOutput(line);
      if (parsed) serverUrl = parsed;
    };
    watchChild(
      sessionId,
      scrape,
      (code) => {
        serverExited = code;
        if (muteUpdates) return;
        onEvent({ type: "session.ended", code });
        const failed = turnFailed;
        turnDone = null;
        turnFailed = null;
        failed?.(new Error("OpenCode server exited"));
      },
      scrape,
    );

    try {
      const port = await freeHarnessPort();
      await spawnChild(sessionId, path, ["serve", "--hostname=127.0.0.1", `--port=${port}`], cwd);
      const url = await waitForServerUrl(() => serverUrl, () => serverExited, SERVER_TIMEOUT_MS);
      const next = new OpenCodeClient(url, cwd);
      const session = await resolveSession(next);
      client = next;
      openCodeSessionId = session.id;

      await next.subscribeEvents(
        sessionId,
        (event) => {
          if (!muteUpdates) handleEvent(event);
        },
        (error) => {
          if (muteUpdates || cancelled || !error) return;
          onEvent({ type: "session.error", message: error });
          turnFailed?.(new Error(error));
        },
      );

      onEvent({ type: "session.providerBound", providerSessionId: session.id });
      onEvent({ type: "session.started" });
    } catch (error) {
      await stop();
      throw error;
    }
  }

  async function resolveSession(next: OpenCodeClient) {
    const permission = buildOpenCodePermissionRules(opts.permission);
    const resumeId = opts.resumeId?.trim();
    if (resumeId) {
      try {
        const adopted = await next.getSession(resumeId);
        const session =
          !adopted.directory || sameDirectory(adopted.directory, cwd)
            ? adopted
            : await next.forkSession(adopted.id, cwd);
        await next.updateSession(session.id, { permission }).catch(() => undefined);
        return session;
      } catch (error) {
        if (!isOpenCodeNotFound(error) && !isHttpNotFound(error)) throw error;
      }
    }
    return next.createSession({ permission });
  }

  function buildParts(turn: OpenCodeTurn): OpenCodePromptPart[] {
    const text = turn.text.trim();
    return [...(text ? [{ type: "text" as const, text }] : []), ...toOpenCodeFileParts(turn.attachments)];
  }

  function promptInput(turn: OpenCodeTurn, parts: OpenCodePromptPart[]) {
    const model = parseOpenCodeModelSlug(turn.model);
    if (!model) {
      throw new Error("OpenCode models use provider/model ids. Wait for the catalog to load, then pick a model.");
    }
    return { sessionID: openCodeSessionId, model, variant: turn.variant, parts };
  }

  async function sendTurn(turn: OpenCodeTurn): Promise<void> {
    const api = live();
    const parts = buildParts(turn);
    if (parts.length === 0) return;
    if (activeTurn) {
      await api.promptAsync(promptInput(turn, parts));
      return;
    }
    turns = turns.catch(() => undefined).then(async () => {
      cancelled = false;
      muteUpdates = false;
      try {
        await runTurn(api, turn, parts);
      } catch (error) {
        if (cancelled) return;
        throw error;
      }
    });
    await turns;
  }

  async function runTurn(api: OpenCodeClient, turn: OpenCodeTurn, parts: OpenCodePromptPart[]): Promise<void> {
    const turnPromise = new Promise<void>((resolve, reject) => {
      turnDone = resolve;
      turnFailed = reject;
    });
    activeTurn = true;
    settlePendingTurn();
    try {
      await api.promptAsync(promptInput(turn, parts));
      settlePendingTurn();
      await turnPromise;
    } catch (error) {
      if (cancelled) return;
      onEvent({ type: "session.error", message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      activeTurn = false;
      turnDone = null;
      turnFailed = null;
    }
  }

  function respondApproval(requestId: number, decision: ApprovalDecision): boolean {
    const pending = approvals.get(requestId);
    if (!pending) return false;
    pending.resolve(decision);
    return true;
  }

  async function answerQuestion(id: string, answers: string[][] | null): Promise<void> {
    if (!openQuestions.delete(id) || !client) return;
    if (answers === null) await client.rejectQuestion(id).catch(() => undefined);
    else await client.replyQuestion(id, answers).catch(() => undefined);
  }

  function denyAll(): void {
    for (const pending of approvals.values()) pending.resolve("deny");
    approvals.clear();
    const api = client;
    for (const id of openQuestions) void api?.rejectQuestion(id).catch(() => undefined);
    openQuestions.clear();
  }

  async function cancelTurn(): Promise<void> {
    if (!client || stopped) return;
    cancelled = true;
    muteUpdates = true;
    denyAll();
    await client.abortSession(openCodeSessionId);
    finishActiveTurn([{ type: "message.completed" }, { type: "reasoning.completed" }]);
  }

  async function stop(): Promise<void> {
    stopped = true;
    muteUpdates = true;
    denyAll();
    activeTurn = false;
    turnDone?.();
    turnDone = null;
    turnFailed = null;
    if (client) {
      if (openCodeSessionId) await client.abortSession(openCodeSessionId);
      await client.closeEvents(sessionId);
    }
    unwatchChild(sessionId);
    await killChild(sessionId).catch(() => undefined);
  }

  function handleEvent(event: Record<string, unknown>): void {
    const payloadSessionId = eventSessionId(event);
    if (payloadSessionId && payloadSessionId !== openCodeSessionId) return;

    const type = typeof event.type === "string" ? event.type : "";
    const properties = asRecord(event.properties) ?? {};

    switch (type) {
      case "message.updated": {
        const info = asRecord(properties.info);
        const id = stringField(info, "id");
        const role = stringField(info, "role");
        if (id && (role === "user" || role === "assistant")) messageRoleById.set(id, role);
        if (role === "assistant") emitContext(info);
        break;
      }
      case "message.removed": {
        const messageID = stringField(properties, "messageID");
        if (messageID) messageRoleById.delete(messageID);
        break;
      }
      case "message.part.delta": {
        const partID = stringField(properties, "partID");
        const delta = streamTextDelta(properties.delta);
        if (!partID || !delta) break;
        const existing = partById.get(partID);
        if (!existing || roleForPart(existing) !== "assistant") break;
        const previous = emittedTextByPartId.get(partID) ?? existing.text ?? "";
        const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(previous, delta);
        emittedTextByPartId.set(partID, nextText);
        if (existing.type === "text" || existing.type === "reasoning") {
          partById.set(partID, { ...existing, text: nextText });
        }
        const mapped = textDeltaEvent(existing, deltaToEmit);
        if (mapped) onEvent(mapped);
        break;
      }
      case "message.part.updated": {
        const part = parsePart(properties.part);
        if (!part) break;
        partById.set(part.id, part);
        if (roleForPart(part) === "assistant") emitAssistantText(part);
        if (part.type === "tool") emitTool(part);
        break;
      }
      case "permission.asked": {
        const id = stringField(properties, "id") ?? stringField(properties, "requestID");
        if (!id) break;
        const permission = stringField(properties, "permission") ?? "tool";
        const patterns = Array.isArray(properties.patterns)
          ? properties.patterns.filter((item): item is string => typeof item === "string")
          : [];
        const metadata = asRecord(properties.metadata) ?? {};
        const callId =
          stringField(properties, "callID") ??
          stringField(properties, "toolCallId") ??
          stringField(metadata, "callID") ??
          stringField(metadata, "toolCallId");
        const uiId = nextApprovalUiId++;
        const kind = toolKindFromName(permission);
        const input = metadata.input ?? (patterns[0] ? { path: patterns[0] } : undefined);
        const preview =
          previewFromToolPart({ id, type: "tool", tool: permission, state: { ...metadata, input } }) ??
          (patterns[0]
            ? previewFromToolPart({
                id,
                type: "tool",
                tool: permission,
                state: { input: { path: patterns[0], pattern: patterns[0] } },
              })
            : undefined);
        const title =
          composeToolTitle({
            kind,
            title: permissionTitle(permission, patterns),
            command: extractShellCommand(metadata.input) ?? (permission === "bash" ? patterns[0] : undefined),
            skill: extractSkillName(metadata.input),
            path: preview?.path,
            query: preview?.query,
            previewKind: preview?.kind,
          }) || permissionTitle(permission, patterns);
        if (callId) onEvent({ type: "tool.updated", callId, title, kind, preview, input });
        onEvent({ type: "approval.requested", requestId: uiId, title, kind, callId, preview });
        void waitApproval(uiId, id);
        break;
      }
      case "question.asked": {
        const id = stringField(properties, "id") ?? stringField(properties, "requestID");
        if (!id) break;
        const questions = parseOpenCodeQuestions(properties.questions);
        if (questions.length === 0) {
          void client?.rejectQuestion(id).catch(() => undefined);
          break;
        }
        openQuestions.add(id);
        onQuestion({
          id,
          questions,
          callId: stringField(properties, "callID") ?? stringField(properties, "toolCallId"),
        });
        break;
      }
      case "session.status": {
        const status = asRecord(properties.status);
        const statusType = stringField(status, "type");
        if (statusType === "retry") {
          const message = stringField(status, "message");
          if (message) onEvent({ type: "status", text: message });
          break;
        }
        if (statusType === "idle" && activeTurn) {
          finishActiveTurn([{ type: "message.completed" }, { type: "reasoning.completed" }]);
        }
        break;
      }
      case "session.error": {
        onEvent({ type: "session.error", message: sessionErrorMessage(properties.error) });
        finishActiveTurn();
        break;
      }
      default:
        break;
    }
  }

  /** opencode reports tokens per assistant message but not the window;
   *  the window comes from the probed catalog entry for that model. */
  function emitContext(info: Record<string, unknown> | null): void {
    const used = contextUsedFromMessageInfo(info);
    if (used === undefined) return;
    const providerID = stringField(info, "providerID");
    const modelID = stringField(info, "modelID");
    const window = providerID && modelID ? modelContextWindow(`${providerID}/${modelID}`) : undefined;
    onEvent({ type: "context", used, ...(window ? { window } : {}) });
  }

  function emitAssistantText(part: OpenCodePart): void {
    if (part.text === undefined) return;
    const previous = emittedTextByPartId.get(part.id);
    const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previous, part.text);
    emittedTextByPartId.set(part.id, latestText);
    const mapped = textDeltaEvent(part, deltaToEmit);
    if (mapped) onEvent(mapped);
  }

  function emitTool(part: OpenCodePart): void {
    const callId = part.callID ?? part.id;
    const tool = part.tool ?? "tool";
    const state = part.state ?? {};
    const status = typeof state.status === "string" ? state.status : "pending";
    const kind = toolKindFromName(tool);
    const preview = previewFromToolPart(part);
    const stateTitle = typeof state.title === "string" && state.title ? state.title : undefined;
    const title =
      composeToolTitle({
        kind,
        title: stateTitle ?? tool,
        command: extractShellCommand(state.input),
        skill: extractSkillName(state.input),
        path: preview?.path,
        query: preview?.query,
        previewKind: preview?.kind,
      }) || stateTitle || tool;
    const input = state.input;
    if (status === "pending") {
      onEvent({ type: "tool.started", callId, title, kind, status: "pending", preview, input });
      return;
    }
    onEvent({
      type: "tool.updated",
      callId,
      title,
      kind,
      status: status === "error" ? "failed" : status,
      detail: detailFromToolPart(part),
      preview,
      input,
    });
  }

  async function waitApproval(uiId: number, id: string): Promise<void> {
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      approvals.set(uiId, { id, resolve });
    });
    approvals.delete(uiId);
    onEvent({ type: "approval.resolved", requestId: uiId, decision });
    await client?.replyPermission(id, toOpenCodePermissionReply(decision)).catch(() => undefined);
  }

  function finishActiveTurn(extraEvents: HarnessEvent[] = []): void {
    turnEndPending = false;
    activeTurn = false;
    for (const event of extraEvents) onEvent(event);
    const done = turnDone;
    const failed = turnFailed;
    turnDone = null;
    turnFailed = null;
    if (done) {
      done();
      return;
    }
    if (!failed) turnEndPending = true;
  }

  function settlePendingTurn(): void {
    if (!turnEndPending || !turnDone) return;
    finishActiveTurn();
  }

  function roleForPart(part: Pick<OpenCodePart, "messageID" | "type">): "assistant" | "user" | undefined {
    if (part.messageID) {
      const known = messageRoleById.get(part.messageID);
      if (known) return known;
    }
    return part.type === "tool" || part.type === "text" || part.type === "reasoning" ? "assistant" : undefined;
  }

  return { start, sendTurn, respondApproval, answerQuestion, cancelTurn, stop };
}

function parsePart(value: unknown): OpenCodePart | null {
  const rec = asRecord(value);
  const id = stringField(rec, "id");
  const type = stringField(rec, "type");
  if (!rec || !id || !type) return null;
  return {
    id,
    type,
    messageID: stringField(rec, "messageID"),
    callID: stringField(rec, "callID"),
    tool: stringField(rec, "tool"),
    text: typeof rec.text === "string" ? rec.text : undefined,
    time: asRecord(rec.time) as OpenCodePart["time"],
    state: asRecord(rec.state) ?? undefined,
  };
}

function sameDirectory(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\/+$/, "").replace(/\\/g, "/");
  return normalize(left) === normalize(right);
}

function isHttpNotFound(error: unknown): boolean {
  return error instanceof OpenCodeHttpError && error.status === 404;
}

async function assertOpenCodeVersion(path: string, cwd: string): Promise<void> {
  const output = await execChild(path, ["--version"], cwd).catch(() => "");
  const version = parseOpenCodeVersion(output);
  if (!version) {
    throw new Error(
      `Unable to determine OpenCode version. MonoCode requires v${MINIMUM_OPENCODE_VERSION} or newer.`,
    );
  }
  if (compareSemver(version, MINIMUM_OPENCODE_VERSION) < 0) {
    throw new Error(`OpenCode v${version} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer.`);
  }
}

function waitForServerUrl(
  read: () => string,
  exited: () => number | null | undefined,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const url = read();
      if (url) return resolve(url);
      if (exited() !== undefined) {
        return reject(new Error(`OpenCode server exited before startup completed (code: ${String(exited())}).`));
      }
      if (Date.now() - started >= timeoutMs) return reject(new Error("Timed out waiting for OpenCode server"));
      setTimeout(tick, 50);
    };
    tick();
  });
}
