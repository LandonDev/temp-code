import { AcpClient, type AcpHandlers } from "./acp";
import {
  killChild,
  resolveFxBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "./child";
import {
  autoPermissionOption,
  eventsFromAcpUpdate,
  extractModelConfigId,
  fxModeId,
  fxPromptBlocks,
  fxToolInput,
  permissionOptionId,
  permissionRequestFromAcp,
  readConfigOptions,
  sessionIdFromResult,
  type SessionConfigOption,
} from "./fxProtocol";
import type { ApprovalDecision, HarnessEvent } from "./types";

/**
 * fx engine — `fx acp` over the server bridge. Ported from
 * src/lib/harness/fx.ts with the same per-session state (live child,
 * resume record, early-cancel set); the Tauri replay buffer and pid guard
 * are gone (the bridge needs neither). Reasoning and model settings are
 * not applied — the driver only passes the native model id.
 */

export type SendTurnInput = {
  sessionId: string;
  cwd: string;
  /** native fx model id; a web-style `fx:` prefix is tolerated */
  model: string;
  text: string;
  onEvent: (event: HarnessEvent) => void;
};

type SessionSetupResult = {
  sessionId?: string;
  session_id?: string;
  configOptions?: unknown;
};

type Live = {
  acp: AcpClient;
  acpSessionId: string;
  cwd: string;
  modelConfigId: string;
  configOptions: SessionConfigOption[];
  muteUpdates: boolean;
  cancelled: boolean;
  onEvent: (event: HarnessEvent) => void;
  turns: Promise<void>;
};

type Resume = {
  acpSessionId: string;
  cwd: string;
};

// fx answers `initialize` in well under a second when it can reach a
// credential. A long wait means it is blocked reading the macOS Keychain, not
// working — so fail fast with something actionable instead of stalling.
const INIT_TIMEOUT_MS = 12_000;
const SESSION_TIMEOUT_MS = 45_000;
const CONTROL_TIMEOUT_MS = 15_000;
const PROMPT_TIMEOUT_MS = 30 * 60_000;

const AUTH_HELP =
  "fx has no Vercel AI Gateway credential it can read from here. " +
  "Run `fx login` (or `fx setup`) in a terminal, or export AI_GATEWAY_API_KEY " +
  "so it does not depend on the macOS Keychain.";

/** fx rejects `initialize` itself when it cannot read a credential. */
function fxStartupError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  if (/needs access|AI Gateway|API key|Keychain/i.test(detail)) {
    return new Error(`${detail.trim()}\n\n${AUTH_HELP}`);
  }
  if (/timed out/i.test(detail)) {
    return new Error(
      `fx did not answer initialize within ${INIT_TIMEOUT_MS / 1000}s. ${AUTH_HELP}`,
    );
  }
  return new Error(`fx did not start. ${detail}`);
}

const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

const liveByThread = new Map<string, Live>();
const resumeByThread = new Map<string, Resume>();
const cancelledThreads = new Set<string>();

/** Run one prompt through the session's fx child, spawning it on first use.
 *  Resolves when fx ends the turn; rejects on startup or transport failure
 *  (the child is recycled, the resume id kept). */
export async function sendFxTurn(input: SendTurnInput): Promise<void> {
  let live: Live;
  try {
    live = await ensureLive(input);
  } catch (error) {
    cancelledThreads.delete(input.sessionId);
    throw error;
  }
  if (cancelledThreads.delete(input.sessionId)) return;

  live.onEvent = input.onEvent;
  live.turns = live.turns
    .catch(() => undefined)
    .then(async () => {
      live.cancelled = false;
      live.muteUpdates = false;
      try {
        await applyModelSelection(live, input.model);
        if (live.cancelled) return;
        await applyRuntimeMode(live);
        if (live.cancelled) return;
        await prompt(live, input.text);
      } catch (error) {
        if (live.cancelled) return;
        throw error;
      }
    });
  try {
    await live.turns;
  } catch (error) {
    // A timed-out or failed turn leaves fx's process state unknowable. Keep
    // its provider session id, but recycle the child so the next turn can
    // resume instead of inheriting a permanently wedged transport.
    if (liveByThread.get(input.sessionId) === live) {
      await stopFxSession(input.sessionId);
    }
    throw error;
  }
}

/** fx auto-approves in `code` mode, so there is never a pending approval. */
export function respondFxApproval(
  _sessionId: string,
  _requestId: number,
  _decision: ApprovalDecision,
): void {}

export async function cancelFxTurn(sessionId: string): Promise<void> {
  const live = liveByThread.get(sessionId);
  if (!live) {
    cancelledThreads.add(sessionId);
    return;
  }
  live.cancelled = true;
  live.muteUpdates = true;
  await live.acp
    .notify("session/cancel", { sessionId: live.acpSessionId })
    .catch(() => undefined);
  live.acp.rejectPending(new Error("cancelled"));
}

export async function stopFxSession(sessionId: string): Promise<void> {
  cancelledThreads.delete(sessionId);
  const live = liveByThread.get(sessionId);
  liveByThread.delete(sessionId);
  if (live) live.muteUpdates = true;
  live?.acp.close();
  unwatchChild(sessionId);
  await killChild(sessionId).catch(() => undefined);
}

export async function forgetFxSession(sessionId: string): Promise<void> {
  resumeByThread.delete(sessionId);
  await stopFxSession(sessionId);
}

/** Seed resume from a persisted ACP session id (SessionMeta.nativeId). */
export function bindFxSession(
  threadId: string,
  acpSessionId: string,
  cwd: string,
): void {
  const sessionId = acpSessionId.trim();
  if (!threadId || !sessionId || !cwd.trim()) return;
  resumeByThread.set(threadId, { acpSessionId: sessionId, cwd });
}

async function ensureLive(input: SendTurnInput): Promise<Live> {
  const existing = liveByThread.get(input.sessionId);
  if (existing && existing.cwd === input.cwd) {
    existing.onEvent = input.onEvent;
    return existing;
  }
  if (existing) {
    resumeByThread.delete(input.sessionId);
    await stopFxSession(input.sessionId);
  }

  const resume = resumeByThread.get(input.sessionId);
  const canLoad = resume != null && resume.cwd === input.cwd;
  if (resume && resume.cwd !== input.cwd) {
    resumeByThread.delete(input.sessionId);
  }

  const { path } = await resolveFxBinary();
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

  // ensureLive runs once per session, so these handlers outlive the turn that
  // created them. Routing through the live record keeps them on the *current*
  // turn's listener.
  const emit = (event: HarnessEvent) => {
    (liveRef.current?.onEvent ?? input.onEvent)(event);
  };

  watchChild(
    input.sessionId,
    (line) => acp.pushLine(line),
    (code) => {
      acp.close(new Error("fx exited"));
      // identity check: only this child's own live record goes away
      if (liveByThread.get(input.sessionId) === liveRef.current) {
        liveByThread.delete(input.sessionId);
      }
      emit({ type: "session.ended", code });
    },
    (line) => {
      if (/Fx needs access|AI Gateway|not start/i.test(line)) {
        emit({ type: "session.error", message: line.trim() });
      }
    },
  );

  await spawnChild(input.sessionId, path, fxSpawnArgs(input.model), input.cwd);

  try {
    try {
      await acp.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: CLIENT_CAPABILITIES,
          clientInfo: { name: "monocode", version: "0.1.0" },
        },
        INIT_TIMEOUT_MS,
      );
    } catch (error) {
      throw fxStartupError(error);
    }

    let setup: SessionSetupResult | undefined;
    let acpSessionId: string | undefined;
    let didLoad = false;

    if (canLoad && resume) {
      try {
        setup = await acp.request<SessionSetupResult>(
          "session/resume",
          { sessionId: resume.acpSessionId },
          SESSION_TIMEOUT_MS,
        );
        acpSessionId = sessionIdFromResult(setup) ?? resume.acpSessionId;
        didLoad = true;
      } catch {
        muteGate.current = true;
        try {
          setup = await acp.request<SessionSetupResult>(
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
      setup = await acp.request<SessionSetupResult>(
        "session/new",
        { cwd: input.cwd, mcpServers: [] },
        SESSION_TIMEOUT_MS,
      );
      acpSessionId = sessionIdFromResult(setup);
    }
    if (!acpSessionId) throw new Error("fx did not return a session id");

    const configOptions = readConfigOptions(setup?.configOptions);
    const live: Live = {
      acp,
      acpSessionId,
      cwd: input.cwd,
      modelConfigId: extractModelConfigId(configOptions),
      configOptions,
      muteUpdates: didLoad,
      cancelled: false,
      onEvent: input.onEvent,
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
    await stopFxSession(input.sessionId);
    throw error;
  }
}

function nativeModelId(model: string): string {
  return model.replace(/^fx:/, "").trim();
}

async function applyModelSelection(live: Live, model: string): Promise<void> {
  const base = nativeModelId(model);
  if (!base) return;
  const modelConfigId =
    live.modelConfigId === "provider" ? "model" : live.modelConfigId;

  await setConfigOption(live, modelConfigId, base).catch((error: unknown) => {
    ignoreUnsupportedControl(error);
  });
  if (modelConfigId !== "model") {
    await setConfigOption(live, "model", base).catch((error: unknown) => {
      ignoreUnsupportedControl(error);
    });
  }
}

async function applyRuntimeMode(live: Live): Promise<void> {
  // Unsupported mode control is non-fatal because handlePermission remains a
  // backstop. Transport failures and timeouts are rethrown so the wedged child
  // is recycled rather than leaving this turn pending forever.
  await live.acp
    .request(
      "session/set_mode",
      { sessionId: live.acpSessionId, modeId: fxModeId("code") },
      CONTROL_TIMEOUT_MS,
    )
    .catch((error: unknown) => {
      ignoreUnsupportedControl(error);
    });
}

async function setConfigOption(
  live: Live,
  configId: string,
  value: string | boolean,
): Promise<void> {
  const encoded = String(value);
  const current = live.configOptions.find((option) => option.id === configId);
  if (current && String(current.currentValue ?? "") === encoded) return;

  const result = await live.acp.request<SessionSetupResult>(
    "session/set_config_option",
    { sessionId: live.acpSessionId, configId, value: encoded },
    CONTROL_TIMEOUT_MS,
  );
  if (result?.configOptions) {
    live.configOptions = readConfigOptions(result.configOptions);
    live.modelConfigId = extractModelConfigId(live.configOptions);
  }
}

function fxSpawnArgs(model: string): string[] {
  const native = nativeModelId(model);
  return native ? ["acp", "--model", native] : ["acp"];
}

async function prompt(live: Live, text: string): Promise<void> {
  const blocks = fxPromptBlocks(text);
  if (blocks.length === 0) return;
  try {
    await live.acp.request(
      "session/prompt",
      { sessionId: live.acpSessionId, prompt: blocks },
      PROMPT_TIMEOUT_MS,
    );
  } catch (error) {
    if (live.cancelled) return;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      /needs access|AI Gateway|API key|Keychain/i.test(detail)
        ? `${detail.trim()}\n\n${AUTH_HELP}`
        : detail,
    );
  }
  if (live.cancelled) return;
  live.onEvent({ type: "message.completed" });
  live.onEvent({ type: "reasoning.completed" });
}

function ignoreUnsupportedControl(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  if (/timed out|not running|exited|closed|pipe/i.test(detail)) throw error;
}

function handleNotification(live: Live, method: string, params: unknown) {
  if (method !== "session/update") return;
  const input = fxToolInput(params);
  for (const event of eventsFromAcpUpdate(params)) {
    live.onEvent(event.type === "tool.updated" && input ? { ...event, input } : event);
  }
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
  await live.acp
    .respondError(id, { code: -32601, message: `Method not found: ${method}` })
    .catch(() => undefined);
}

/**
 * fx polices its own permissions in `code` mode, so anything that still reaches
 * us is answered immediately. We never park a turn on an approval — that is
 * what left sessions stuck on "Working…" with an empty transcript.
 */
async function handlePermission(live: Live, id: number, params: unknown) {
  const request = permissionRequestFromAcp(params);
  if (request.callId) {
    live.onEvent({
      type: "tool.updated",
      callId: request.callId,
      title: request.title,
      kind: request.kind,
      preview: request.preview,
      input: fxToolInput(params),
    });
  }
  const optionId =
    autoPermissionOption("code", request.optionIds) ??
    permissionOptionId("allow", request.optionIds);
  await live.acp.respond(id, { outcome: { outcome: "selected", optionId } });
}
