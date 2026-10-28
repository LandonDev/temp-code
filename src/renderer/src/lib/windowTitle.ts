import { leafIds, type LayoutNode } from "./layout";
import { sessionDisplayTitle, UNTITLED_THREAD, type HarnessId } from "./session";

/** What the window's title reads: the page that covers the window, else
 *  the focused pane and its project. Electron copies `document.title` to
 *  the window, so this is the Window menu's, Mission Control's and ⌘`'s
 *  name for it. No "— TempCode" suffix: macOS names the app already. */

export type TitlePage = "settings" | "search" | "inbox" | "notes" | "accounts" | "stats";

export type TitlePane =
  | { kind: "thread"; title: string }
  | { kind: "file"; path: string }
  | { kind: "terminal" };

export type TitleFacts = {
  page: TitlePage | null;
  pane: TitlePane | null;
  project: string | null;
};

const PAGE_TITLES: Record<TitlePage, string> = {
  settings: "Settings",
  search: "Search",
  inbox: "Inbox",
  notes: "Notes",
  accounts: "Accounts",
  stats: "Stats",
};

/** A thread's pane: its display title, so a bare harness title ("claude")
 *  reads as untitled. */
export function threadPane(session: { title: string; harness: HarnessId }): TitlePane {
  return { kind: "thread", title: sessionDisplayTitle(session.title, session.harness) };
}

type TitleThread = { id: string; title: string; harness: HarnessId; projectId?: string | null };

/**
 * The thread the window is named for: the focused pane's, from its open
 * session or, while that is still opening (a thread just opened to the
 * side), from its meta; never another pane's. A tab whose focus names no
 * thread (a file, a stale id) falls back to its first thread.
 */
export function titleThread<S extends TitleThread>(
  tab: { focusedId: string; layout: LayoutNode } | undefined,
  sessions: readonly S[],
  metaOf: (id: string) => TitleThread | null,
): TitleThread | undefined {
  if (!tab) return undefined;
  const leaves = leafIds(tab.layout);
  const focused =
    sessions.find((session) => session.id === tab.focusedId) ??
    (leaves.includes(tab.focusedId) ? metaOf(tab.focusedId) : null);
  return focused ?? sessions.find((session) => leaves.includes(session.id));
}

export function windowTitle({ page, pane, project }: TitleFacts): string {
  if (page) return PAGE_TITLES[page];
  if (!pane) return "TempCode";
  const name =
    pane.kind === "thread"
      ? pane.title.trim() || UNTITLED_THREAD
      : pane.kind === "file"
        ? pane.path.split(/[\\/]/).filter(Boolean).pop() || pane.path
        : "Terminal";
  return project ? `${name} — ${project}` : name;
}
