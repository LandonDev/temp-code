import { useCallback, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { ThreadRules } from "@server/shared/rules";
import type { ThreadType } from "../lib/tcserver/types";
import type { HeaderModel } from "../lib/threadHeaderModel";
import { pauseAllLabel, type PauseAllState } from "../lib/threadHeaderModel";
import type { ReadyMap } from "../lib/threadStripModel";
import { THREAD_LABELS } from "../surfaces/threads/bits";
import { ExplorerMenu, type ExplorerMenuItem } from "./ExplorerMenu";
import { NewThreadChooser } from "./NewThreadChooser";
import { ConfirmDialog } from "./ProjectDialogs";
import { PanelRight } from "./icons";
import { ThreadHeaderStrip, chipTitle, type ArchivedThread, type ChipThread, type StripChip } from "./ThreadHeaderStrip";
import { TuneDialog } from "./ThreadTune";
import { IconButton } from "./TitleBar";

/**
 * The deck title bar's thread surface: temp-code's strip and heading
 * controls inside MonoCode's shell. Owns the chip menu, inline rename, the
 * tune and delete dialogs, Pause all and the rail toggle; every action goes
 * back to App by thread id.
 */

export type ThreadAction = "pause" | "resume" | "stop";

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
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  onAction: (id: string, action: ThreadAction) => void;
  onSetRules: (id: string, rules: ThreadRules | null) => void;
  onRestore: (id: string) => void;
  onNew: (threadType: ThreadType, tune: ThreadRules | null) => void;
  onPauseAll: () => Promise<unknown>;
  onToggleRail: () => void;
};

const TUNABLE: ReadonlySet<ThreadType> = new Set(["orchestration", "research"]);

export function chipMenuItems(chip: StripChip): ExplorerMenuItem[] {
  const t = chip.thread;
  const items: ExplorerMenuItem[] = [{ kind: "item", id: "rename", label: "Rename" }];
  if (t.threadType && TUNABLE.has(t.threadType))
    items.push({ kind: "item", id: "tune", label: `${THREAD_LABELS[t.threadType]} options…` });
  const paused = chip.status === "paused";
  const working = !!t.treeHasLiveWork || chip.status === "running" || chip.status === "starting";
  const live = working || paused || chip.status === "waiting" || chip.status === "watching";
  if (paused) items.push({ kind: "item", id: "resume", label: "Continue" });
  else if (working) items.push({ kind: "item", id: "pause", label: "Pause" });
  if (live) items.push({ kind: "item", id: "stop", label: "Stop", danger: true });
  items.push({ kind: "sep" }, { kind: "item", id: "archive", label: "Archive" });
  items.push({ kind: "sep" }, { kind: "item", id: "delete", label: "Delete…", danger: true });
  return items;
}

export function ThreadHeader({
  model,
  planReady,
  archived,
  workspaceId,
  cost,
  running,
  railOpen,
  onSelect,
  onRename,
  onArchive,
  onDelete,
  onAction,
  onSetRules,
  onRestore,
  onNew,
  onPauseAll,
  onToggleRail,
  stripRef,
  activeRef,
}: ThreadHeaderProps & {
  stripRef: (el: HTMLDivElement | null) => void;
  activeRef: (el: HTMLDivElement | null) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; chip: StripChip } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [tuning, setTuning] = useState<StripChip | null>(null);
  const [deleting, setDeleting] = useState<StripChip | null>(null);
  const [pauseAll, setPauseAll] = useState<PauseAllState>("idle");

  const onContextMenu = useCallback((chip: StripChip, event: ReactMouseEvent<HTMLDivElement>) => {
    setMenu({ x: event.clientX, y: event.clientY, chip });
  }, []);

  const onPick = (id: string) => {
    if (!menu) return;
    const chip = menu.chip;
    setMenu(null);
    if (id === "rename") setRenamingId(chip.id);
    else if (id === "tune") setTuning(chip);
    else if (id === "archive") onArchive(chip.id);
    else if (id === "delete") setDeleting(chip);
    else onAction(chip.id, id as ThreadAction);
  };

  const commitRename = (id: string, title: string) => {
    setRenamingId(null);
    const chip = model.live.find((c) => c.id === id) ?? model.dormant.find((c) => c.id === id);
    if (title && chip && title !== chip.thread.title) onRename(id, title);
  };

  const pauseAllNow = async () => {
    if (pauseAll === "busy") return;
    setPauseAll("busy");
    try {
      await onPauseAll();
      setPauseAll("idle");
    } catch {
      setPauseAll("failed");
    }
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
        onContextMenu={onContextMenu}
        activeRef={activeRef}
        stripRef={stripRef}
        archived={archived}
        onRestore={onRestore}
        trailing={<NewThreadChooser workspaceId={workspaceId} empty={empty} onStart={onNew} />}
        end={
          <div className="mr-1.5 flex shrink-0 items-center gap-1">
            {cost != null && cost > 0 ? (
              <span className="px-1 text-[11px] tabular-nums text-content/50" title="Cost of this thread so far">
                ${cost.toFixed(2)}
              </span>
            ) : null}
            {running > 0 ? (
              <button
                type="button"
                data-tauri-drag-region="false"
                title={`Pause ${running === 1 ? "the running thread" : `${running} running threads`}`}
                aria-busy={pauseAll === "busy"}
                onClick={() => void pauseAllNow()}
                className={`h-6 rounded-md px-2 text-[12px] hover:bg-content/5 ${
                  pauseAll === "failed" ? "text-danger" : "text-content/50 hover:text-content"
                }`}
              >
                {pauseAllLabel(pauseAll)}
              </button>
            ) : null}
            <IconButton label={railOpen ? "Hide rail" : "Show rail"} active={railOpen} onClick={onToggleRail}>
              <PanelRight className="size-3.5" strokeWidth={1.75} />
            </IconButton>
          </div>
        }
      />
      {menu ? (
        <ExplorerMenu
          x={menu.x}
          y={menu.y}
          items={chipMenuItems(menu.chip)}
          ariaLabel="Thread actions"
          onPick={onPick}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {tuning ? (
        <TuneDialog
          title={`${THREAD_LABELS[tuning.thread.threadType ?? "chat"]} options · ${chipTitle(tuning)}`}
          initial={tuning.thread.threadRules}
          workspaceId={workspaceId}
          onCancel={() => setTuning(null)}
          onSave={(rules) => {
            setTuning(null);
            onSetRules(tuning.id, rules);
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title={`Delete ${chipTitle(deleting)}?`}
          body="The thread and its whole transcript are gone for good. Archive keeps it instead."
          confirmLabel="Delete thread"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            setDeleting(null);
            onDelete(deleting.id);
          }}
        />
      ) : null}
    </>
  );
}
