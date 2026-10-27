import type { ReactElement } from "react";
import { inboxFilterMenuRows, type InboxFilterMenuRow, type InboxFilterWorkspaceOption } from "../lib/inboxFilterMenu";
import type { InboxFilters, InboxSource } from "../lib/inboxFilters";
import { AtSign, CircleCheck, CircleDashed, CircleDot, Clock, GitMerge, GitPullRequest, X } from "./icons";
import { RowsMenu, type MenuIcon, type MenuRow } from "./menuRows";
import { ProjectLogoIcon } from "./ProjectLogoIcon";

type Props = {
  /** The inbox's filter button. */
  trigger: ReactElement;
  /** GitHub workspaces to offer; pass none to hide the section. */
  workspaces: InboxFilterWorkspaceOption[];
  source: InboxSource;
  filters: InboxFilters;
  onChange: (filters: InboxFilters) => void;
  onOpenChange?: (open: boolean) => void;
};

type FilterItem = Extract<InboxFilterMenuRow, { kind: "item" }>;

const logos = new Map<string, MenuIcon>();
/** One stable glyph component per workspace, so a re-render keeps its image. */
function workspaceLogo(workspace: InboxFilterWorkspaceOption): MenuIcon {
  const key = `${workspace.id}\0${workspace.logoPath ?? ""}`;
  let icon = logos.get(key);
  if (!icon) {
    icon = function WorkspaceLogo() {
      return (
        <ProjectLogoIcon
          path={workspace.logoPath ?? undefined}
          workspaceId={workspace.id}
          className="size-3.5 shrink-0 rounded-md"
          imageClassName="size-3.5"
        />
      );
    };
    logos.set(key, icon);
  }
  return icon;
}

const STATUS_GLYPHS: Record<string, MenuIcon> = { open: CircleDot, draft: CircleDashed, closed: CircleCheck, merged: GitMerge, clear: X };

function glyph(item: FilterItem): MenuIcon {
  if (item.icon && "workspace" in item.icon) return workspaceLogo(item.icon.workspace);
  if (item.icon) return item.icon.kind === "pr" ? GitPullRequest : CircleDot;
  if (item.key.startsWith("mine:")) return AtSign;
  if (item.key.startsWith("time:")) return Clock;
  return STATUS_GLYPHS[item.key] ?? CircleDot;
}

/** The inbox's filters as one menu of checked rows over `inboxFilterMenuRows`. */
export function InboxFiltersMenu({ trigger, workspaces, source, filters, onChange, onOpenChange }: Props) {
  const items = () => inboxFilterMenuRows({ source, filters, workspaces, onChange });
  const rows = (): MenuRow[] =>
    items().map((item): MenuRow => {
      if (item.kind === "label") return { kind: "label", label: item.text };
      if (item.kind === "separator") return { kind: "sep" };
      return item.key === "clear"
        ? { kind: "item", id: item.key, label: item.label, icon: glyph(item) }
        : { kind: "item", id: item.key, label: item.label, icon: glyph(item), checked: item.checked, keepOpen: true };
    });
  const pick = (id: string) => {
    const item = items().find((row): row is FilterItem => row.kind === "item" && row.key === id);
    item?.onClick();
  };
  return (
    <RowsMenu
      trigger={trigger}
      label="Filter inbox"
      tip={{ label: "Filters" }}
      rows={rows}
      onPick={pick}
      onOpenChange={onOpenChange}
      align="end"
      className="max-h-120 w-57"
    />
  );
}
