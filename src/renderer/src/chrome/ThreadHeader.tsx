import { sessionStore } from "../lib/tcserver/store";
import { useState, useSyncExternalStore } from "react";
import type { ThreadRules } from "@server/shared/rules";
import type { ThreadType } from "../lib/tcserver/types";
import type { HeaderModel } from "../lib/threadHeaderModel";
import type { ReadyMap } from "../lib/threadStripModel";
import { NewThreadChooser } from "./NewThreadChooser";
import { ProjectPlanChip } from "./ProjectPlanChip";
import { ThreadHeaderStrip, type ArchivedThread, type ChipThread } from "./ThreadHeaderStrip";
import { ThreadMenu } from "./ThreadMenu";
import { useThreadHost } from "./ThreadHostChip";
import { useThreadMenu } from "./useThreadMenu";
import { devPane, useDevPane } from "../lib/devPane";
import { useDevRunning, useDevServable } from "../lib/devServers";
import { useProjects } from "../lib/tcserver/workspaces";
import { useMasterIds } from "../lib/masterThread";

/**
 * The deck title bar's thread surface: temp-code's strip and heading
 * controls inside MonoCode's shell. The chips' right-click and the ⋯ menu
 * are the thread's one menu (chrome/useThreadMenu.tsx); this keeps the
 * inline rename, Pause all and the panel toggle, and hands rename, archive,
 * delete, the type and the options back to App by thread id.
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

/** Dev server in the thread menu (docs/box.md "Dev servers on the box"):
 *  offered when a host can serve the thread's project or one of its servers
 *  runs; it opens and closes the Dev servers pane and never starts anything. */
function useDevServer(sessionId: string | null): { shown: boolean; open: boolean; onToggle: () => void } {
  // The thread's project and host only: a streaming turn must not re-render the header.
  const where = useSyncExternalStore(sessionStore.subscribe, () => {
    const s = sessionId ? sessionStore.get(sessionId) : undefined;
    return s?.projectId ? `${s.environmentId}|${s.projectId}` : "";
  });
  const [environmentId, projectId] = where.split("|");
  const project = useProjects().find((p) => p.id === projectId && p.environmentId === environmentId);
  const servable = useDevServable(project);
  const running = useDevRunning(project?.id);
  const open = useDevPane((s) => s.open);
  return { shown: !!project && (servable || running), open, onToggle: devPane.toggle };
}

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
  activeRef,
}: ThreadHeaderProps & {
  stripRef: (el: HTMLDivElement | null) => void;
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
    onScreen: (id) => id === model.activeId,
  });
  const host = useThreadHost(model.activeId);
  const masterIds = useMasterIds();
  const dev = useDevServer(model.activeId);
  const activeChip = model.live.find((c) => c.id === model.activeId) ?? null;

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
        trailing={
          <>
            <NewThreadChooser workspaceId={workspaceId} empty={empty} onStart={onNew} />
            <ProjectPlanChip />
          </>
        }
        end={
          <ThreadMenu
            host={activeChip ? host.host : null}
            cost={cost}
            rows={activeChip ? menu.rowsFor(activeChip.id) : []}
            onPick={(id) => activeChip && menu.onPick(activeChip.id, id)}
            onOpen={() => menu.onOpenChange(model.activeId, true)}
            running={running}
            onPauseAll={onPauseAll}
            dev={dev}
            terminal={{ onShow: onShowTerminal, onNew: onNewTerminal, active: projectTerminalActive }}
            recent={model.dormant}
            onOpenRecent={onSelect}
            archived={archived}
            onRestore={onRestore}
            panel={{ open: railOpen, room: panelRoom, onToggle: onToggleRail }}
          />
        }
      />
      {menu.dialogs}
    </>
  );
}
