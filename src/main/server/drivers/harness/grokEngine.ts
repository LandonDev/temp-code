import { AcpClient, type AcpHandlers } from "./acp";
import {
  killChild,
  resolveGrokBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "./child";
import {
  AUTH_HELP,
  askQuestionAnswers,
  askQuestionsFromAcp,
  asRecord,
  contextWindowFromSetup,
  currentModelId,
  eventsFromAcpUpdate,
  grokAuthError,
  grokAuthMethodId,
  grokEffort,
  grokNativeModelId,
  grokPromptBlocks,
  grokSessionNewParams,
  grokSpawnArgs,
  permissionOptionId,
  permissionRequestFromAcp,
  pickAutoOption,
  planFromExitPlan,
  sessionIdFromResult,
  type GrokAskQuestion,
  type RuntimeMode,
} from "./grokProtocol";
import type { ApprovalDecision, HarnessEvent } from "./types";

/**
 * Ported from src/lib/harness/grok.ts over the server bridge. Changes:
 * the turn input is declared here (the web SendTurnInput lived in its
 * types.ts), the model id is the native grok id, and ask_user_question
 * goes through `onQuestion` so the driver can carry a real
 * question-request instead of flattening it into an approval. The
 * replay buffer and pid guard live in the bridge; the identity check on
 * exit stays here so a stale exit never evicts a respawned session.
 */

export type SendTurnInput = {
  sessionId: string;
  cwd: string;
  /** native grok model id ("grok-4.6"); a "grok:" prefix is stripped */
  model: string;
  modelSettings?: Record<string, string>;
  runtimeMode: RuntimeMode;
  text: string;
  onEvent: (event: HarnessEvent) => void;
  /** Resolve with the user's answers (null = dismissed). Absent: the
   *  questions are skipped. */
  onQuestion?: (questions: GrokAskQuestion[]) => Promise<string[][] | null>;
};

type Live = {
  acp: AcpClient;
  acpSessionId: string;
  cwd: string;
  modelId: string;
  contextWindow?: number;
  muteUpdates: boolean;
  cancelled: boolean;
  fullAccess: boolean;
  runtimeMode: RuntimeMode;
  onEvent: (event: HarnessEvent) => void;
  onQuestion?: SendTurnInput["onQuestion"];
  approvals: Map<number, (decision: ApprovalDecision) => void>;
  turns: Promise<void>;
};

type Resume = {
  acpSessionId: string;
  cwd: string;
};

const INIT_TIMEOUT_MS = 12_000;
const AUTH_TIMEOUT_MS = 15_000;
const SESSION_TIMEOUT_MS = 45_000;
const CONTROL_TIMEOUT_MS = 15_000;
const PROMPT_TIMEOUT_MS = 30 * 60_000;

const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

const liveByThread = new Map<string, Live>();
const resumeByThread = new Map<string, Resume>();
const cancelledThreads = new Set<string>();

/**
 * Live Grok Build engine. Spawns `grok agent stdio` and talks ACP.
 * Image/audio prompt blocks are not supported; the driver degrades
 * attachments to path references.
 */
export async function sendGrokTurn(input: SendTurnInput): Promise<void> {
  let live: Live;
  try {
    live = await ensureLive(input);
  } catch (error) {
    cancelledThreads.delete(input.sessionId);
    throw error;
  }
  if (cancelledThreads.delete(input.sessionId)) return;

  live.onEvent = input.onEvent;
  live.onQuestion = input.onQuestion;
  live.runtimeMode = input.runtimeMode;
  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
      live.cancelled = false;
      live.muteUpdates = false;
      try {
        await applyModelSelection(live, input);
        if (live.cancelled) return;
        await prompt(live, input);
      } catch (error) {
        if (live.cancelled) return;
        throw error;
      }
    });
  try {
    await live.turns;
  } catch (error) {
    if (liveByThread.get(input.sessionId) === live) {
      await stopGrokSession(input.sessionId);
    }
    throw error;
  }
}

export function respondGrokApproval(
  sessionId: string,
  requestId: number,
  decision: ApprovalDecision,
): boolean {
  const resolve = liveByThread.get(sessionId)?.approvals.get(requestId);
  if (!resolve) return false;
  resolve(decision);
  return true;
}

export async function cancelGrokTurn(sessionId: string): Promise<void> {
  const live = liveByThread.get(sessionId);
  if (!live) {
    cancelledThreads.add(sessionId);
    return;
  }
  live.cancelled = true;
  live.muteUpdates = true;
  for (const [, resolve] of live.approvals) resolve("deny");
  live.approvals.clear();
  await live.acp
    .notify("session/cancel", { sessionId: live.acpSessionId })
    .catch(() => undefined);
  live.acp.rejectPending(new Error("cancelled"));
}

export async function stopGrokSession(sessionId: string): Promise<void> {
  cancelledThreads.delete(sessionId);
  const live = liveByThread.get(sessionId);
  liveByThread.delete(sessionId);
  if (live) {
    live.muteUpdates = true;
    for (const [, resolve] of live.approvals) resolve("deny");
    live.approvals.clear();
  }
  live?.acp.close();
  unwatchChild(sessionId);
  await killChild(sessionId).catch(() => undefined);
}

export async function forgetGrokSession(sessionId: string): Promise<void> {
  resumeByThread.delete(sessionId);
  await stopGrokSession(sessionId);
}

/** Seed the ACP session id to resume on the next turn. */
export function bindGrokSession(
  threadId: string,
  acpSessionId: string,
  cwd: string,
): void {
  const sessionId = acpSessionId.trim();
  if (!threadId || !sessionId || !cwd.trim()) return;
  resumeByThread.set(threadId, { acpSessionId: sessionId, cwd });
}

async function ensureLive(input: SendTurnInput): Promise<Live> {
  const wantFullAccess = input.runtimeMode === "full-access";
  const existing = liveByThread.get(input.sessionId);
  if (
    existing &&
    existing.cwd === input.cwd &&
    existing.fullAccess === wantFullAccess
  ) {
    existing.onEvent = input.onEvent;
    existing.onQuestion = input.onQuestion;
    existing.runtimeMode = input.runtimeMode;
    return existing;
  }
  if (existing) {
    await stopGrokSession(input.sessionId);
  }

  const resume = resumeByThread.get(input.sessionId);
  const canLoad = resume != null && resume.cwd === input.cwd;
  if (resume && resume.cwd !== input.cwd) {
    resumeByThread.delete(input.sessionId);
  }

  const { path } = await resolveGrokBinary();
  const handlers: AcpHandlers = {};
  const acp = new AcpClient(input.sessionId, handlers);
  const liveRef: { current: Live | null } = { current: null };
  const muteGate = { current: false };

  handlers.onNotification = (method, params) => {
    if (muteGate.current) return;
    const live = liveRef.current;
    if (!live || live.muteUpdates) return;
    handleNotification(live, method, params);
  };
  handlers.onRequest = (id, method, params) => {
    const live = liveRef.current;
    if (!live) {
      void acp
        .respondError(id, {
          code: -32601,
          message: `Method not found: ${method}`,
        })
        .catch(() => undefined);
      return;
    }
    void handleRequest(live, id, method, params);
  };

  const emit = (event: HarnessEvent) => {
    (liveRef.current?.onEvent ?? input.onEvent)(event);
  };

  watchChild(
    input.sessionId,
    (line) => acp.pushLine(line),
    (code) => {
      acp.close(new Error("Grok Build exited"));
      // identity check: only this child's own session leaves the map
      if (liveByThread.get(input.sessionId) === liveRef.current) {
        liveByThread.delete(input.sessionId);
      }
      emit({ type: "session.ended", code });
    },
    (line) => {
      console.debug("[monocode] grok stderr", line);
      if (/not authenticated|Authentication required|XAI_API_KEY/i.test(line)) {
        emit({ type: "session.error", message: `${line.trim()}\n\n${AUTH_HELP}` });
      }
    },
  );

  await spawnChild(
    input.sessionId,
    path,
    grokSpawnArgs({
      model: input.model,
      effort: grokEffort(input.modelSettings),
      fullAccess: wantFullAccess,
    }),
    input.cwd,
  );

  try {
    let init: unknown;
    try {
      init = await acp.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: CLIENT_CAPABILITIES,
          clientInfo: { name: "monocode", version: "0.1.0" },
        },
        INIT_TIMEOUT_MS,
      );
    } catch (error) {
      throw grokAuthError(error);
    }

    const methodId = grokAuthMethodId(init);
    if (methodId) {
      await acp
        .request(
          "authenticate",
          { methodId, _meta: { headless: true } },
          AUTH_TIMEOUT_MS,
        )
        .catch((error: unknown) => {
          console.debug("[monocode] grok authenticate", error);
        });
    }

    let setup: unknown;
    let acpSessionId: string | undefined;
    let didLoad = false;

    if (canLoad && resume) {
      try {
        setup = await acp.request(
          "session/resume",
          { sessionId: resume.acpSessionId },
          SESSION_TIMEOUT_MS,
        );
        acpSessionId = sessionIdFromResult(setup) ?? resume.acpSessionId;
        didLoad = true;
      } catch {
        muteGate.current = true;
        try {
          setup = await acp.request(
            "session/load",
            {
              sessionId: resume.acpSessionId,
              cwd: input.cwd,
              mcpServers: [],
            },
            SESSION_TIMEOUT_MS,
          );
          acpSessionId = sessionIdFromResult(setup) ?? resume.acpSessionId;
          didLoad = true;
        } catch {
          setup = undefined;
          acpSessionId = undefined;
          didLoad = false;
        } finally {
          muteGate.current = false;
        }
      }
    }

    if (!acpSessionId) {
      try {
        setup = await acp.request(
          "session/new",
          grokSessionNewParams(input.cwd, input.runtimeMode),
          SESSION_TIMEOUT_MS,
        );
      } catch (error) {
        throw grokAuthError(error);
      }
      acpSessionId = sessionIdFromResult(setup);
    }
    if (!acpSessionId) throw new Error("Grok Build did not return a session id");

    const live: Live = {
      acp,
      acpSessionId,
      cwd: input.cwd,
      modelId: currentModelId(setup) ?? grokNativeModelId(input.model),
      contextWindow: contextWindowFromSetup(setup) ?? contextWindowFromSetup(init),
      muteUpdates: didLoad,
      cancelled: false,
      fullAccess: wantFullAccess,
      runtimeMode: input.runtimeMode,
      onEvent: input.onEvent,
      onQuestion: input.onQuestion,
      approvals: new Map(),
      turns: Promise.resolve(),
    };
    liveRef.current = live;
    liveByThread.set(input.sessionId, live);
    resumeByThread.set(input.sessionId, {
      acpSessionId,
      cwd: input.cwd,
    });
    live.onEvent({
      type: "session.providerBound",
      providerSessionId: acpSessionId,
    });
    live.onEvent({ type: "session.started" });
    return live;
  } catch (error) {
    acp.close(error instanceof Error ? error : new Error(String(error)));
    await stopGrokSession(input.sessionId);
    throw error;
  }
}

async function applyModelSelection(
  live: Live,
  input: SendTurnInput,
): Promise<void> {
  const base = grokNativeModelId(input.model);
  if (base && base !== live.modelId) {
    await live.acp
      .request(
        "session/set_model",
        { sessionId: live.acpSessionId, modelId: base },
        CONTROL_TIMEOUT_MS,
      )
      .then(() => {
        live.modelId = base;
      })
      .catch((error: unknown) => {
        ignoreUnsupportedControl("set_model", error);
      });
  }

  const effort = grokEffort(input.modelSettings);
  if (!effort) return;
  await live.acp
    .request(
      "session/set_mode",
      { sessionId: live.acpSessionId, modeId: effort },
      CONTROL_TIMEOUT_MS,
    )
    .catch((error: unknown) => {
      ignoreUnsupportedControl("set_mode", error);
    });
}

async function prompt(live: Live, input: SendTurnInput): Promise<void> {
  try {
    const blocks = grokPromptBlocks(input.text);
    if (blocks.length === 0) return;
    await live.acp.request(
      "session/prompt",
      {
        sessionId: live.acpSessionId,
        prompt: blocks,
      },
      PROMPT_TIMEOUT_MS,
    );
    if (live.cancelled) return;
    live.onEvent({ type: "message.completed" });
    live.onEvent({ type: "reasoning.completed" });
  } catch (error) {
    if (live.cancelled) return;
    const detail = error instanceof Error ? error.message : String(error);
    live.onEvent({
      type: "session.error",
      message: /auth|login|credential|api key|XAI_API_KEY/i.test(detail)
        ? `${detail.trim()}\n\n${AUTH_HELP}`
        : detail,
    });
    throw error;
  }
}

function ignoreUnsupportedControl(method: string, error: unknown): void {
  console.debug(`[monocode] grok ${method} failed`, error);
  const detail = error instanceof Error ? error.message : String(error);
  if (/timed out|not running|exited|closed|pipe/i.test(detail)) throw error;
}

function handleNotification(live: Live, method: string, params: unknown) {
  const updateParams =
    method === "session/update"
      ? params
      : method === "_x.ai/session_notification" || method === "x.ai/session_notification"
        ? unwrapSessionNotification(params)
        : null;
  if (!updateParams) return;
  for (const event of eventsFromAcpUpdate(updateParams)) {
    if (event.type === "context" && event.window == null && live.contextWindow) {
      live.onEvent({ ...event, window: live.contextWindow });
    } else {
      live.onEvent(event);
    }
  }
}

function unwrapSessionNotification(params: unknown): unknown {
  const rec = asRecord(params);
  if (!rec) return params;
  if (rec.update != null || rec.sessionUpdate != null) return rec;
  const nested = asRecord(rec.notification) ?? asRecord(rec.payload);
  return nested ?? rec;
}

async function handleRequest(
  live: Live,
  id: number,
  method: string,
  params: unknown,
) {
  if (method === "session/request_permission") {
    await handlePermission(live, id, params);
    return;
  }
  if (
    method === "_x.ai/ask_user_question" ||
    method === "x.ai/ask_user_question"
  ) {
    await handleAskQuestion(live, id, params);
    return;
  }
  if (method === "_x.ai/exit_plan_mode" || method === "x.ai/exit_plan_mode") {
    const plan = planFromExitPlan(params);
    if (plan) live.onEvent({ type: "plan", text: plan });
    await live.acp
      .respond(id, { outcome: { outcome: "accepted" } })
      .catch(() => undefined);
    return;
  }
  await live.acp
    .respondError(id, {
      code: -32601,
      message: `Method not found: ${method}`,
    })
    .catch(() => undefined);
}

async function handlePermission(
  live: Live,
  id: number,
  params: unknown,
) {
  const request = permissionRequestFromAcp(params);
  if (request.callId) {
    live.onEvent({
      type: "tool.updated",
      callId: request.callId,
      title: request.title,
      kind: request.kind,
      preview: request.preview,
      input: request.input,
    });
  }

  const auto = pickAutoOption(
    live.runtimeMode,
    request.kind,
    request.optionIds,
  );
  if (auto) {
    await live.acp.respond(id, {
      outcome: { outcome: "selected", optionId: auto },
    });
    return;
  }

  live.onEvent({
    type: "approval.requested",
    requestId: id,
    title: request.title,
    kind: request.kind,
    callId: request.callId,
    preview: request.preview,
  });

  const decision = await new Promise<ApprovalDecision>((resolve) => {
    live.approvals.set(id, resolve);
  });
  live.approvals.delete(id);
  live.onEvent({ type: "approval.resolved", requestId: id, decision });

  await live.acp.respond(id, {
    outcome: {
      outcome: "selected",
      optionId: permissionOptionId(decision, request.optionIds),
    },
  });
}

async function handleAskQuestion(
  live: Live,
  id: number,
  params: unknown,
) {
  const questions = askQuestionsFromAcp(params);
  const answers = live.onQuestion
    ? await live.onQuestion(questions).catch(() => null)
    : null;
  await live.acp
    .respond(id, askQuestionAnswers(questions, answers))
    .catch(() => undefined);
}
