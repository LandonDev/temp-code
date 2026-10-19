/**
 * `window.__app` — the dev-build facade CDP scripts drive the app through.
 *
 * Installed by App.tsx in dev builds (`import.meta.env.DEV`) and in
 * measurement builds (`TEMP_CODE_PROFILE=1`, electron.vite.config.ts), next to
 * `window.__monocode` (the raw server client, lib/tcserver/link.ts). Where
 * `__monocode.registry.primary()` talks to the server directly, `__app` goes through the
 * renderer's own paths — the same store, command map and actions the UI
 * uses — so a script exercises what a user would.
 *
 * Surface (stable for the exit tests; M12 builds on it):
 *   store.getState()            open sessions (blocks, status, cwd, …)
 *   store.subscribe(fn)         change notifications; returns unsubscribe
 *   store.metas()               every thread the server knows, unopened too
 *   store.get(id)               one open session
 *   store.waitIdle(id)          resolves when the turn settles
 *   run(id, index?)             an app command by id (lib/appCommands.ts)
 *   newSession()                open a fresh thread in the current project → id
 *   openSession(id, seq?)       open a thread; with seq, scroll to that row
 *   send(id, text)              submit text into a thread's composer path
 *   answer(id, requestId, a)    answer a question card (null = dismiss)
 *   searchSessions(query)       what the Search view sees for this query
 *   editors()                   paths of the editors registered for Save All
 *   zoom()                      current zoom level
 *   renders()                   dev render tallies by component ({ app, composerInput, … })
 *   feed(opts)                  stream a seeded synthetic turn into an open thread
 *                               through the store's push path (no server, no model);
 *                               resolves with the pushed counts
 *   profile.start/read/stop     root-Profiler commit time and long tasks (lib/renderProfile.ts)
 *   commands                    the command id list
 */
import { LOCAL_ENVIRONMENT_ID } from "./connection";
import { APP_COMMANDS, type AppCommand, type AppCommandId } from "./appCommands";
import { devRenders } from "./devRenders";
import { registeredEditorPaths } from "./editorFlush";
import type { Session } from "./session";
import { searchSessions } from "./sessionStore";
import { readProfile, startProfile, stopProfile, type RenderProfile } from "./renderProfile";
import { answer } from "./tcserver/commands";
import { sessionStore } from "./tcserver/store";
import type { AgentEvent, ProviderId, SessionMeta } from "./tcserver/types";
import { loadZoom } from "./zoom";

export type AppFacadeHandlers = {
  execute: (cmd: AppCommand) => void;
  newSession: () => string;
  openSession: (id: string, seq?: number) => Promise<void>;
  send: (id: string, text: string) => void;
};

export type AppFacade = {
  store: {
    getState: () => Session[];
    subscribe: (fn: () => void) => () => void;
    metas: () => SessionMeta[];
    get: (id: string) => Session | undefined;
    waitIdle: (id: string) => Promise<void>;
  };
  commands: readonly AppCommandId[];
  run: (id: AppCommandId, index?: number) => void;
  newSession: () => string;
  openSession: (id: string, seq?: number) => Promise<void>;
  send: (id: string, text: string) => void;
  answer: (id: string, requestId: string, answers: string[][] | null) => Promise<void>;
  searchSessions: typeof searchSessions;
  editors: () => string[];
  zoom: () => number;
  renders: () => Readonly<Record<string, number>>;
  feed: (opts: FeedOptions) => Promise<FeedResult>;
  profile: { start: () => void; read: () => RenderProfile; stop: () => RenderProfile };
};

export type FeedOptions = {
  sessionId: string;
  /** how long the stream runs */
  seconds?: number;
  /** event rows per second (deltas plus tool rows) */
  perSecond?: number;
  /** a tool-call + tool-result pair after this many text deltas */
  toolEvery?: number;
};

export type FeedResult = { session: number; event: number; ms: number };

/** Thinking deltas run this long before the answer text starts. */
const FEED_THINKING_MS = 5000;
const FEED_TICK_MS = 8;
const FEED_WORDS =
  "the store folds each delta into one block per frame so a streamed answer costs a single reconcile while tool rows land between text blocks and the composer header strip and rail all follow the same session meta".split(
    " ",
  );

/** mulberry32: the same seed gives both arms the same bytes. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function feedMeta(sessionId: string, status: SessionMeta["status"], now: number): SessionMeta {
  const s = sessionStore.get(sessionId);
  const prev = sessionStore.metaOf(sessionId);
  return {
    id: sessionId,
    environmentId: LOCAL_ENVIRONMENT_ID,
    parentId: null,
    projectId: s?.projectId ?? null,
    workspaceId: s?.workspaceId ?? null,
    threadType: s?.threadType ?? "chat",
    planPath: null,
    provider: (s?.harness ?? "claude") as ProviderId,
    model: s?.model ?? "",
    reasoning: "medium",
    agentType: "implementer",
    title: s?.title ?? "Synthetic feed",
    cwd: s?.cwd ?? "~",
    pinned: false,
    archived: false,
    permission: "edits",
    fast: false,
    ultrafast: false,
    context1m: false,
    pausedAt: null,
    frozenActiveElapsed: null,
    nativeId: null,
    ...prev,
    status,
    busySince: status === "running" ? (prev?.busySince ?? now) : null,
    activity: status === "running" ? "Writing" : null,
    activityKind: status === "running" ? "edit" : null,
    createdAt: prev?.createdAt ?? s?.createdAt ?? now,
    updatedAt: now,
  };
}

/**
 * A scripted turn pushed through `sessionStore.injectPush`: a `session` meta
 * with status running, thinking deltas for the first five seconds, then
 * assistant-text deltas (one msgId and blockIndex per text block, so every
 * delta appends to the same block), a complete tool-call plus its tool-result
 * every `toolEvery` deltas, and a closing turn-complete with the meta back
 * to idle. Rows are paced by wall clock so a slow frame never changes how
 * many rows a second carries; the byte stream is the same on every run.
 */
async function feed({
  sessionId,
  seconds = 60,
  perSecond = 120,
  toolEvery = 40,
}: FeedOptions): Promise<FeedResult> {
  const before = sessionStore.pushCounts();
  const started = performance.now();
  const rand = prng(0x5eed);
  const total = Math.round(seconds * perSecond);
  let seq = 0;
  let textDeltas = 0;
  let block = 0;
  let tool = 0;
  const push = (event: AgentEvent): void => {
    seq += 1;
    sessionStore.injectPush({ push: "event", row: { sessionId, seq, ts: Date.now(), event } }, LOCAL_ENVIRONMENT_ID);
  };
  const words = (): string => {
    const n = 1 + Math.floor(rand() * 4);
    let out = "";
    for (let i = 0; i < n; i++) out += FEED_WORDS[Math.floor(rand() * FEED_WORDS.length)] + " ";
    return rand() < 0.08 ? out + "\n\n" : out;
  };
  const msgId = (n: number): string => `feed-${n}`;

  sessionStore.injectPush({ push: "session", session: feedMeta(sessionId, "running", Date.now()) }, LOCAL_ENVIRONMENT_ID);
  push({ type: "user-text", text: "Synthetic feed: stream a long answer with tool calls." });

  await new Promise<void>((done) => {
    let sent = 0;
    const tick = (): void => {
      const elapsed = performance.now() - started;
      const due = Math.min(total, Math.floor((elapsed * perSecond) / 1000));
      while (sent < due) {
        sent += 1;
        if (elapsed < FEED_THINKING_MS) {
          push({ type: "thinking", text: words(), delta: true, msgId: msgId(block), blockIndex: 0 });
          continue;
        }
        textDeltas += 1;
        if (textDeltas % toolEvery === 0) {
          tool += 1;
          const callId = `feed-call-${tool}`;
          push({
            type: "tool-call",
            callId,
            name: "Read",
            input: { file_path: `src/renderer/src/lib/feed-${tool}.ts` },
            partial: false,
          });
          push({ type: "tool-result", callId, output: words().repeat(6), isError: false });
          sent += 1;
          block += 1;
          continue;
        }
        push({ type: "assistant-text", text: words(), delta: true, msgId: msgId(block), blockIndex: 1 });
      }
      if (sent >= total && elapsed >= seconds * 1000) done();
      else window.setTimeout(tick, FEED_TICK_MS);
    };
    tick();
  });

  push({ type: "turn-complete", inputTokens: 1000, outputTokens: textDeltas * 3 });
  sessionStore.injectPush({ push: "session", session: feedMeta(sessionId, "idle", Date.now()) }, LOCAL_ENVIRONMENT_ID);
  const after = sessionStore.pushCounts();
  return {
    session: after.session - before.session,
    event: after.event - before.event,
    ms: Math.round(performance.now() - started),
  };
}


declare global {
  interface Window {
    __app?: AppFacade;
  }
}

/** Dev and measurement builds only. The handlers close over App state, so App re-installs on change. */
export function installAppFacade(handlers: AppFacadeHandlers): void {
  if (!import.meta.env.DEV && import.meta.env.TEMP_CODE_PROFILE !== "1") return;
  window.__app = {
    store: {
      getState: () => sessionStore.getSnapshot(),
      subscribe: (fn) => sessionStore.subscribe(fn),
      metas: () => sessionStore.metas(),
      get: (id) => sessionStore.get(id),
      waitIdle: (id) => sessionStore.waitIdle(id),
    },
    commands: APP_COMMANDS,
    run: (id, index) => handlers.execute({ id, index }),
    newSession: handlers.newSession,
    openSession: handlers.openSession,
    send: handlers.send,
    answer,
    searchSessions,
    editors: registeredEditorPaths,
    zoom: loadZoom,
    renders: () => ({ ...devRenders }),
    feed,
    profile: { start: startProfile, read: readProfile, stop: stopProfile },
  };
}
