import { Check, CircleDot, GitPullRequest } from "./icons";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import type { InboxKind } from "../lib/githubTasks";
import {
  DEFAULT_INBOX_FILTERS,
  hasActiveInboxFilters,
  type InboxFilters,
  type InboxSource,
  type InboxTimeFilter,
} from "../lib/inboxFilters";
import { Popover } from "./Popover";
import { ProjectLogoIcon } from "./ProjectLogoIcon";

export const INBOX_FILTER_MENU_WIDTH = 228;

type ProjectOption = {
  /** workspace id */
  id: string;
  name: string;
  logoPath: string | null;
};

type Props = {
  x: number;
  y: number;
  projects: ProjectOption[];
  source: InboxSource;
  filters: InboxFilters;
  onChange: (filters: InboxFilters) => void;
  onClose: () => void;
};

const TIME_OPTIONS: { id: InboxTimeFilter; label: string }[] = [
  { id: "all", label: "All time" },
  { id: "today", label: "Today" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
];

const KIND_OPTIONS: {
  id: InboxKind;
  label: string;
  icon: ReactNode;
}[] = [
  {
    id: "issue",
    label: "Issues",
    icon: <CircleDot className="size-3.5 shrink-0" strokeWidth={1.75} />,
  },
  {
    id: "pr",
    label: "Pull requests",
    icon: <GitPullRequest className="size-3.5 shrink-0" strokeWidth={1.75} />,
  },
];

type Item =
  | { kind: "label"; text: string }
  | { kind: "separator" }
  | { kind: "item"; key: string; label: string; checked: boolean; icon?: ReactNode; onClick: () => void };

export function InboxFiltersMenu({
  x,
  y,
  projects,
  source,
  filters,
  onChange,
  onClose,
}: Props) {
  const hiddenWorkspaces = new Set(filters.hiddenWorkspaceIds);
  const hiddenKinds = new Set(filters.hiddenKinds);
  const [active, setActive] = useState(-1);

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

  const toggleStatus = (key: keyof InboxFilters["status"]) => {
    onChange({
      ...filters,
      status: { ...filters.status, [key]: !filters.status[key] },
    });
  };

  const github = source === "github";
  const items: Item[] = [
    {
      kind: "item",
      key: "assigned",
      label: "Assigned to me",
      checked: filters.assignedToMe,
      onClick: () => onChange({ ...filters, assignedToMe: !filters.assignedToMe }),
    },
    { kind: "label", text: "Status" },
    { kind: "item", key: "open", label: "Open", checked: filters.status.open, onClick: () => toggleStatus("open") },
    ...(github
      ? [{ kind: "item", key: "draft", label: "Draft", checked: filters.status.draft, onClick: () => toggleStatus("draft") } as Item]
      : []),
    { kind: "item", key: "closed", label: "Closed", checked: filters.status.closed, onClick: () => toggleStatus("closed") },
    ...(github
      ? [{ kind: "item", key: "merged", label: "Merged", checked: filters.status.merged, onClick: () => toggleStatus("merged") } as Item]
      : []),
    { kind: "label", text: "Time" },
    ...TIME_OPTIONS.map<Item>((option) => ({
      kind: "item",
      key: `time:${option.id}`,
      label: option.label,
      checked: filters.time === option.id,
      onClick: () => onChange({ ...filters, time: option.id }),
    })),
    ...(github
      ? [
          { kind: "label", text: "Type" } as Item,
          ...KIND_OPTIONS.map<Item>((option) => ({
            kind: "item",
            key: `kind:${option.id}`,
            label: option.label,
            checked: !hiddenKinds.has(option.id),
            icon: option.icon,
            onClick: () => toggleKind(option.id),
          })),
        ]
      : []),
    ...(github && projects.length > 0
      ? [
          { kind: "label", text: "Workspaces" } as Item,
          ...projects.map<Item>((project) => ({
            kind: "item",
            key: `workspace:${project.id}`,
            label: project.name,
            checked: !hiddenWorkspaces.has(project.id),
            icon: (
              <ProjectLogoIcon
                path={project.logoPath ?? undefined}
                workspaceId={project.id}
                className="size-3.5 shrink-0 rounded-md"
                imageClassName="size-3.5"
              />
            ),
            onClick: () => toggleWorkspace(project.id),
          })),
        ]
      : []),
    ...(hasActiveInboxFilters(filters, source)
      ? [
          { kind: "separator" } as Item,
          {
            kind: "item",
            key: "clear",
            label: "Clear filters",
            checked: false,
            onClick: () => onChange(DEFAULT_INBOX_FILTERS),
          } as Item,
        ]
      : []),
  ];
  const rows = items.map((item, i) => (item.kind === "item" ? i : -1)).filter((i) => i >= 0);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return;
    const at = rows.indexOf(active);
    const step = (next: number) => {
      event.preventDefault();
      setActive(rows[(next + rows.length) % rows.length]);
    };
    if (event.key === "ArrowDown") step(at + 1);
    else if (event.key === "ArrowUp") step(at < 0 ? rows.length - 1 : at - 1);
    else if (event.key === "Home") step(0);
    else if (event.key === "End") step(rows.length - 1);
    else if (event.key === "Enter" || event.key === " ") {
      const item = items[active];
      if (item?.kind !== "item") return;
      event.preventDefault();
      item.onClick();
    }
  };

  return (
    <Popover
      anchor={{ x, y }}
      gap={0}
      width={INBOX_FILTER_MENU_WIDTH}
      maxHeight={480}
      autoFocus
      onDismiss={onClose}
      role="menu"
      aria-label="Filter inbox"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      className="overflow-y-auto overscroll-none p-1"
    >
      {items.map((item, index) => {
        if (item.kind === "label") return <SectionLabel key={`label:${item.text}`}>{item.text}</SectionLabel>;
        if (item.kind === "separator")
          return <div key="separator" role="separator" className="my-1 h-px bg-content/10" />;
        return (
          <FilterItem
            key={item.key}
            label={item.label}
            checked={item.checked}
            icon={item.icon}
            highlighted={active === index}
            onHover={() => setActive(index)}
            onClick={item.onClick}
          />
        );
      })}
    </Popover>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="px-2 pb-1 pt-2 text-[11px] font-semibold tracking-[0.08em] text-content/50 uppercase">
      {children}
    </div>
  );
}

function FilterItem({
  label,
  checked,
  icon,
  highlighted,
  onHover,
  onClick,
}: {
  label: string;
  checked: boolean;
  icon?: ReactNode;
  highlighted: boolean;
  onHover: () => void;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={onHover}
      onClick={onClick}
      className={`flex h-7 w-full items-center gap-3 rounded-lg px-2 text-left text-[13px] leading-none active:bg-content/10 ${
        highlighted ? "bg-content/10 text-content" : "text-content hover:bg-content/5"
      }`}
    >
      <span className="grid size-3.5 shrink-0 place-items-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked ? <Check className="size-3.5 shrink-0" strokeWidth={2.25} /> : null}
    </button>
  );
}
