/**
 * `window.__monocode.open(sessionId, { split })`: a measurement script's way
 * to put a thread on screen in every build (`__app` exists only in dev and
 * TEMP_CODE_PROFILE builds; scripts/measure-renderer-soak.ts runs a plain
 * production build). It goes through App's own open handler, so a script
 * opens what a click opens: a tab, or with `split` a pane beside the
 * focused one.
 */
import { leafIds } from "./layout";
import type { Session } from "./session";
import { workspaceTabsStore } from "../stores/workspace";

export type MonocodeOpenOptions = { split?: boolean };

export type MonocodeOpenDeps = {
  /** App's open handler: a tab for the thread, or the one already showing it. */
  open: (sessionId: string) => Promise<void>;
  /** The thread loaded into the store, null when its host does not know it. */
  ensure: (sessionId: string) => Promise<Session | null>;
  /** App's split: the thread in a pane beside the source's. */
  beside: (sourceId: string, session: Session) => void;
};

let deps: MonocodeOpenDeps | null = null;

/** App registers its handlers on mount and clears them on unmount. */
export function setMonocodeOpen(next: MonocodeOpenDeps | null): void {
  deps = next;
}

/** The focused pane's thread in the active tab, if a thread is there. */
function focusedThread(): string | null {
  const { tabs, activeTabId } = workspaceTabsStore.getState();
  const tab = tabs.find((entry) => entry.id === activeTabId);
  if (!tab?.focusedId || !leafIds(tab.layout).includes(tab.focusedId)) return null;
  return tab.focusedId;
}

export async function monocodeOpen(sessionId: string, options: MonocodeOpenOptions = {}): Promise<void> {
  if (!deps) throw new Error("the app has not mounted yet");
  const source = options.split ? focusedThread() : null;
  if (!source || source === sessionId) return deps.open(sessionId);
  const session = await deps.ensure(sessionId);
  if (!session) throw new Error(`no thread ${sessionId} on any connected host`);
  deps.beside(source, session);
}
