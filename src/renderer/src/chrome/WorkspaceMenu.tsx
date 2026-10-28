import type { ReactElement } from "react";
import type { ThreadType } from "../lib/tcserver/types";
import { THREAD_MENU_ICONS } from "../surfaces/threads/threadTypes";
import { Archive, FileText, FolderPlus, MessageSquarePlus, Settings, SlidersHorizontal, Workflow, X } from "./icons";
import { RowsMenu, tidy, type MenuRow } from "./menuRows";

type Props = {
  /** The workspace header's ⋯ button. */
  trigger: ReactElement;
  onNewProject: () => void;
  onNewChat: () => void;
  /** Settled, seen, unpinned roots across the workspace; 0 greys the item. */
  dormantCount: number;
  onArchiveDormant: () => void;
  /** Per-type rows under the all-types one; empty when one type covers them. */
  dormantGroups?: readonly { type: string; label: string }[];
  onArchiveDormantType?: (type: string) => void;
  /** Absent when the rail that owns the appearance menu is not on screen. */
  onWorkspaceSettings?: () => void;
  onThreadDefaults?: () => void;
  onOrchestration?: () => void;
  /** The workspace's default preamble for projects without their own. */
  onPreamble?: () => void;
  onRemoveWorkspace?: () => void;
  canNewProject: boolean;
};

/** The ⋯ menu on a workspace header. */
export function WorkspaceMenu({
  trigger,
  onNewProject,
  onNewChat,
  dormantCount,
  onArchiveDormant,
  dormantGroups = [],
  onArchiveDormantType,
  onWorkspaceSettings,
  onThreadDefaults,
  onOrchestration,
  onPreamble,
  onRemoveWorkspace,
  canNewProject,
}: Props) {
  const rows = (): MenuRow[] =>
    tidy([
      { kind: "item", id: "new-project", label: "New project", icon: FolderPlus, disabled: !canNewProject },
      { kind: "item", id: "new-chat", label: "New chat", icon: MessageSquarePlus },
      { kind: "sep" },
      {
        kind: "item",
        id: "archive-dormant",
        label: dormantCount > 0 ? `Archive ${dormantCount} dormant thread${dormantCount === 1 ? "" : "s"}` : "Archive dormant threads",
        icon: Archive,
        disabled: dormantCount === 0,
      },
      ...dormantGroups.map((g): MenuRow => ({
        kind: "item",
        id: `archive-dormant:${g.type}`,
        label: g.label,
        icon: THREAD_MENU_ICONS[g.type as ThreadType] ?? Archive,
      })),
      { kind: "sep" },
      ...(onThreadDefaults ? [{ kind: "item", id: "thread-defaults", label: "Thread defaults", icon: SlidersHorizontal } as const] : []),
      ...(onOrchestration ? [{ kind: "item", id: "orchestration", label: "Orchestration", icon: Workflow } as const] : []),
      ...(onPreamble ? [{ kind: "item", id: "preamble", label: "Preamble…", icon: FileText } as const] : []),
      ...(onWorkspaceSettings ? [{ kind: "item", id: "settings", label: "Workspace settings", icon: Settings } as const] : []),
      { kind: "sep" },
      ...(onRemoveWorkspace ? [{ kind: "item", id: "remove", label: "Remove workspace", icon: X, danger: true } as const] : []),
    ]);
  const pick = (id: string) => {
    if (id === "new-project") onNewProject();
    else if (id === "new-chat") onNewChat();
    else if (id === "archive-dormant") onArchiveDormant();
    else if (id.startsWith("archive-dormant:")) onArchiveDormantType?.(id.slice("archive-dormant:".length));
    else if (id === "thread-defaults") onThreadDefaults?.();
    else if (id === "orchestration") onOrchestration?.();
    else if (id === "preamble") onPreamble?.();
    else if (id === "settings") onWorkspaceSettings?.();
    else if (id === "remove") onRemoveWorkspace?.();
  };
  return (
    <RowsMenu
      label="Workspace actions"
      tip={{ label: "Workspace options", side: "bottom" }}
      trigger={trigger}
      rows={rows}
      onPick={pick}
      className="w-52"
    />
  );
}
