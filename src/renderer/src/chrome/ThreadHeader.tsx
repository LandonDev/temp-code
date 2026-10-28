import { useState } from "react";
import type { ThreadRules } from "@server/shared/rules";
import type { ThreadType } from "../lib/tcserver/types";
import type { HeaderModel } from "../lib/threadHeaderModel";
import type { ReadyMap } from "../lib/threadStripModel";
import { NewThreadChooser } from "./NewThreadChooser";
import { ProjectPlanChip } from "./ProjectPlanChip";
import {
  ThreadHeaderStrip,
  type ArchivedThread,
  type ChipThread,
  type StripOverflow,
} from "./ThreadHeaderStrip";
import { ThreadMenu } from "./ThreadMenu";
import { useThreadHost } from "./ThreadHostChip";
import { useThreadMenu } from "./useThreadMenu";
import { useMasterIds } from "../lib/masterThread";

/**
 * The deck title bar's thread surface: temp-code's strip and heading
 * controls inside MonoCode's shell. The chips' right-click and the ⋯ menu
 * are the thread's one menu (chrome/useThreadMenu.tsx); this keeps the
 * inline rename, Pause all and the panel toggle, and hands rename, archive,
 * delete, the type and the options back to App by thread id. The end group
 * is the project plan's chip when there is one, then ⋯, then Panel.
 */

export type ThreadHeaderProps = {
  model: HeaderModel<ChipThread>;
  planReady: ReadyMap;
  archived: ArchivedThread[];
  /** The selected project's workspace, for the tune's base rules. */
  workspaceId: string | null;
  /** The active thread's cumulative cost in dollars, when known. */
  cost: number | null;
  /** Roots with live work anywhere in their tree. */
  running: number;
  railOpen: boolean;
  /** False while the thread's row is too narrow to draw the panel. */
  panelRoom?: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  onSetRules: (id: string, rules: ThreadRules | null) => void;
  onRestore: (id: string) => void;
  onNew: (threadType: ThreadType, tune: ThreadRules | null) => void;
  onPauseAll: () => Promise<unknown>;
  onToggleRail: () => void;
  /** The thread menu's Type rows (App's onThreadTypeChange). */
  onSetType: (id: string, threadType: ThreadType) => void;
};

export function ThreadHeader({
  model,
  planReady,
  archived,
  workspaceId,
  cost,
  running,
  railOpen,
  panelRoom,
  onSelect,
  onRename,
  onArchive,
  onDelete,
  onSetRules,
  onRestore,
  onNew,
  onPauseAll,
  onToggleRail,
  onSetType,
  onShowTerminal,
  onNewTerminal,
  projectTerminalActive = false,
  stripRef,
  overflow,
  onScrollBy,
  activeRef,
}: ThreadHeaderProps & {
  stripRef: (el: HTMLDivElement | null) => void;
  /** The live row's overflow and its scroll, from the title bar. */
  overflow?: StripOverflow;
  onScrollBy?: (direction: -1 | 1) => void;
  activeRef: (el: HTMLDivElement | null) => void;
  /** The project terminal, from the title bar: the menu's Terminal row. */
  onShowTerminal?: () => void;
  onNewTerminal?: () => void;
  projectTerminalActive?: boolean;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const menu = useThreadMenu({
    onRename: setRenamingId,
    onArchive,
    onDelete,
    onSetType,
    onSetRules,
  });
  const host = useThreadHost(model.activeId);
  const masterIds = useMasterIds();
  // The active chip sits on either row: a settled thread on screen is on the shelf.
  const activeChip =
    model.live.find((c) => c.id === model.activeId) ??
    model.dormant.find((c) => c.id === model.activeId) ??
    null;

  const commitRename = (id: string, title: string) => {
    setRenamingId(null);
    const chip = model.live.find((c) => c.id === id) ?? model.dormant.find((c) => c.id === id);
    if (title && chip && title !== chip.thread.title) onRename(id, title);
  };

  const empty = model.live.length === 0 && model.dormant.length === 0;
  return (
    <>
      <ThreadHeaderStrip
        model={model}
        planReady={planReady}
        renamingId={renamingId}
        onSelect={onSelect}
        onStartRename={setRenamingId}
        onRename={commitRename}
        menu={{
          rowsFor: (id) => (id ? menu.rowsFor(id) : null),
          onPick: (pick, id) => id && menu.onPick(id, pick),
          onOpenChange: (open, id) => menu.onOpenChange(id, open),
        }}
        activeRef={activeRef}
        masterIds={masterIds}
        stripRef={stripRef}
        overflow={overflow}
        onScrollBy={onScrollBy}
        trailing={<NewThreadChooser workspaceId={workspaceId} empty={empty} onStart={onNew} />}
        end={
          <div className="flex shrink-0 items-center gap-0.5">
            <ProjectPlanChip />
            <ThreadMenu
            host={activeChip ? host.host : null}
            cost={cost}
            rows={activeChip ? menu.rowsFor(activeChip.id) : []}
            onPick={(id) => activeChip && menu.onPick(activeChip.id, id)}
            onOpen={() => menu.onOpenChange(model.activeId, true)}
            running={running}
            onPauseAll={onPauseAll}
            terminal={{ onShow: onShowTerminal, onNew: onNewTerminal, active: projectTerminalActive }}
            recent={model.dormant}
            onOpenRecent={onSelect}
            archived={archived}
            onRestore={onRestore}
            panel={{ open: railOpen, room: panelRoom, onToggle: onToggleRail }}
            />
          </div>
        }
      />
      {menu.dialogs}
    </>
  );
}
