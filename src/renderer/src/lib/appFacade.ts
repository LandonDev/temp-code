/**
 * `window.__app` — the dev-build facade CDP scripts drive the app through.
 *
 * Installed by App.tsx in dev builds only (`import.meta.env.DEV`), next to
 * `window.__monocode` (the raw server client, lib/tcserver/link.ts). Where
 * `__monocode.server` talks to the server directly, `__app` goes through the
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
 *   commands                    the command id list
 */
import { APP_COMMANDS, type AppCommand, type AppCommandId } from "./appCommands";
import { registeredEditorPaths } from "./editorFlush";
import type { Session } from "./session";
import { searchSessions } from "./sessionStore";
import { answer } from "./tcserver/commands";
import { sessionStore } from "./tcserver/store";
import type { SessionMeta } from "./tcserver/types";
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
};

declare global {
  interface Window {
    __app?: AppFacade;
  }
}

/** Dev only. The handlers close over App state, so App re-installs on change. */
export function installAppFacade(handlers: AppFacadeHandlers): void {
  if (!import.meta.env.DEV) return;
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
  };
}
