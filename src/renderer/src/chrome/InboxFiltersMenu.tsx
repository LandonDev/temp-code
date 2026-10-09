import { Check, CircleDot, GitPullRequest } from "./icons";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { inboxFilterMenuRows, type InboxFilterWorkspaceOption } from "../lib/inboxFilterMenu";
import type { InboxFilters, InboxSource } from "../lib/inboxFilters";
import { Popover } from "./Popover";
import { ProjectLogoIcon } from "./ProjectLogoIcon";

export const INBOX_FILTER_MENU_WIDTH = 228;

type Props = {
  x: number;
  y: number;
  /** GitHub workspaces to offer; pass none to hide the section. */
  workspaces: InboxFilterWorkspaceOption[];
  source: InboxSource;
  filters: InboxFilters;
  onChange: (filters: InboxFilters) => void;
  onClose: () => void;
};

function rowIcon(icon: { kind: "issue" | "pr" | "linear" } | { workspace: InboxFilterWorkspaceOption } | undefined): ReactNode {
  if (!icon) return undefined;
  if ("workspace" in icon) {
    return (
      <ProjectLogoIcon
        path={icon.workspace.logoPath ?? undefined}
        workspaceId={icon.workspace.id}
        className="size-3.5 shrink-0 rounded-md"
        imageClassName="size-3.5"
      />
    );
  }
  if (icon.kind === "pr") return <GitPullRequest className="size-3.5 shrink-0" strokeWidth={1.75} />;
  return <CircleDot className="size-3.5 shrink-0" strokeWidth={1.75} />;
}

export function InboxFiltersMenu({ x, y, workspaces, source, filters, onChange, onClose }: Props) {
  const [active, setActive] = useState(-1);
  const items = inboxFilterMenuRows({ source, filters, workspaces, onChange });
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
            icon={rowIcon(item.icon)}
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
