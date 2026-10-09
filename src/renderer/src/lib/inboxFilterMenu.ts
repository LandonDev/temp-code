import type { InboxKind } from "./githubTasks";
import {
  DEFAULT_INBOX_FILTERS,
  hasActiveInboxFilters,
  type InboxFilters,
  type InboxSource,
  type InboxTimeFilter,
} from "./inboxFilters";

/**
 * The rows of the inbox filter menu, built without React so a test can
 * read them. The component attaches icons by `icon` and renders the rest.
 */

export type InboxFilterWorkspaceOption = {
  /** workspace id */
  id: string;
  name: string;
  logoPath: string | null;
};

export type InboxFilterMenuRow =
  | { kind: "label"; text: string }
  | { kind: "separator" }
  | {
      kind: "item";
      key: string;
      label: string;
      checked: boolean;
      icon?: { kind: InboxKind } | { workspace: InboxFilterWorkspaceOption };
      onClick: () => void;
    };

const TIME_OPTIONS: { id: InboxTimeFilter; label: string }[] = [
  { id: "all", label: "All time" },
  { id: "today", label: "Today" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
];

const KIND_OPTIONS: { id: InboxKind; label: string }[] = [
  { id: "issue", label: "Issues" },
  { id: "pr", label: "Pull requests" },
];

const MINE_OPTIONS: { id: keyof InboxFilters["mine"]; label: string }[] = [
  { id: "authored", label: "Authored by me" },
  { id: "assigned", label: "Assigned to me" },
  { id: "reviewRequested", label: "Review requested" },
];

export function inboxFilterMenuRows(args: {
  source: InboxSource;
  filters: InboxFilters;
  /** GitHub workspaces to offer; empty hides the section (e.g. one-workspace scope). */
  workspaces: InboxFilterWorkspaceOption[];
  onChange: (filters: InboxFilters) => void;
}): InboxFilterMenuRow[] {
  const { source, filters, workspaces, onChange } = args;
  const github = source === "github";
  const hiddenWorkspaces = new Set(filters.hiddenWorkspaceIds);
  const hiddenKinds = new Set(filters.hiddenKinds);

  const toggleMine = (key: keyof InboxFilters["mine"]) =>
    onChange({ ...filters, mine: { ...filters.mine, [key]: !filters.mine[key] } });
  const toggleStatus = (key: keyof InboxFilters["status"]) =>
    onChange({ ...filters, status: { ...filters.status, [key]: !filters.status[key] } });
  const toggleKind = (kind: InboxKind) => {
    const next = new Set(hiddenKinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    onChange({ ...filters, hiddenKinds: [...next] });
  };
  const toggleWorkspace = (id: string) => {
    const next = new Set(hiddenWorkspaces);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange({ ...filters, hiddenWorkspaceIds: [...next] });
  };

  const item = (
    key: string,
    label: string,
    checked: boolean,
    onClick: () => void,
    icon?: Extract<InboxFilterMenuRow, { kind: "item" }>["icon"],
  ): InboxFilterMenuRow => ({ kind: "item", key, label, checked, icon, onClick });
  const label = (text: string): InboxFilterMenuRow => ({ kind: "label", text });

  // Linear's fetch only knows "assigned to me"; GitHub's snapshot knows all three.
  const mine = github ? MINE_OPTIONS : MINE_OPTIONS.filter((o) => o.id === "assigned");
  const rows: InboxFilterMenuRow[] = [
    ...(github ? [label("Mine")] : []),
    ...mine.map((o) => item(`mine:${o.id}`, o.label, filters.mine[o.id], () => toggleMine(o.id))),
    label("Status"),
    item("open", "Open", filters.status.open, () => toggleStatus("open")),
    ...(github ? [item("draft", "Draft", filters.status.draft, () => toggleStatus("draft"))] : []),
    item("closed", "Closed", filters.status.closed, () => toggleStatus("closed")),
    ...(github ? [item("merged", "Merged", filters.status.merged, () => toggleStatus("merged"))] : []),
    label("Time"),
    ...TIME_OPTIONS.map((o) =>
      item(`time:${o.id}`, o.label, filters.time === o.id, () => onChange({ ...filters, time: o.id })),
    ),
    ...(github
      ? [
          label("Type"),
          ...KIND_OPTIONS.map((o) =>
            item(`kind:${o.id}`, o.label, !hiddenKinds.has(o.id), () => toggleKind(o.id), { kind: o.id }),
          ),
        ]
      : []),
    ...(github && workspaces.length > 0
      ? [
          label("Workspaces"),
          ...workspaces.map((w) =>
            item(`workspace:${w.id}`, w.name, !hiddenWorkspaces.has(w.id), () => toggleWorkspace(w.id), {
              workspace: w,
            }),
          ),
        ]
      : []),
    ...(hasActiveInboxFilters(filters, source)
      ? [{ kind: "separator" } as InboxFilterMenuRow, item("clear", "Clear filters", false, () => onChange(DEFAULT_INBOX_FILTERS))]
      : []),
  ];
  return rows;
}
