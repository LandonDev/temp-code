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

export function windowTitle({ page, pane, project }: TitleFacts): string {
  if (page) return PAGE_TITLES[page];
  if (!pane) return "TempCode";
  const name =
    pane.kind === "thread"
      ? pane.title.trim() || "New thread"
      : pane.kind === "file"
        ? pane.path.split(/[\\/]/).filter(Boolean).pop() || pane.path
        : "Terminal";
  return project ? `${name} — ${project}` : name;
}
