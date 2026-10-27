import { tidy, type MenuRow } from "../chrome/menuRows";
import {
  Archive,
  Blocks,
  FoldVertical,
  Laptop,
  Layers,
  Lock,
  Maximize2,
  MessageSquarePlus,
  PanelRight,
  Pause,
  Pencil,
  Play,
  SlidersHorizontal,
  Square,
  Star,
  StopCircle,
  Target,
  Trash2,
  X,
} from "../chrome/icons";
import { THREAD_GLYPHS, THREAD_LABELS, THREAD_TYPES } from "../surfaces/threads/threadTypes";
import { masterMenuLabel } from "./masterThread";
import type { SessionStatus, ThreadType } from "./tcserver/types";

/**
 * A thread's menu, one list for every surface (the tab chip's right-click,
 * the ⋯ thread menu, the title-bar tab, the rail's rows, the board's rows
 * and the subagent lines under them), so the rows never drift. A surface
 * adds only what it alone can do (`extra`): Open where the thread is not on
 * screen, New pass… on the board, and Start now for a queued board row.
 * chrome/useThreadMenu.tsx answers every pick and mounts the dialogs.
 */

export type ThreadMenuFacts = {
  status: SessionStatus;
  treeHasLiveWork?: boolean;
  treeHasPaused?: boolean;
  threadType: ThreadType | null;
  projectId: string | null;
  parentId: string | null;
  master: boolean;
  /** Live resources on the ledger (worktrees, simulators, dev instances). */
  resources: number;
  /** null: no Goal… row (the harness keeps no goal, or no composer is on
   *  screen to answer); else checked while a goal runs. */
  goal: boolean | null;
  /** The Mac bridge's switch, for a thread on another host than the Mac. */
  bridge?: { on: boolean; online: boolean; inherited: boolean; known: boolean };
  /** "Move to <host>…" rows (useThreadHost). */
  moves: readonly MenuRow[];
  /** Open to the side: a pane is focused on screen and it is not this thread's. */
  side?: boolean;
};

export type ThreadMenuExtra = { open?: boolean; newPass?: boolean };

/** The thread types with an options dialog (chrome/ThreadTune.tsx). */
const TUNABLE: ReadonlySet<ThreadType> = new Set(["orchestration", "research"]);

export function threadMenuRows(facts: ThreadMenuFacts, extra: ThreadMenuExtra = {}): MenuRow[] {
  const { status } = facts;
  const queued = status === "queued";
  const paused = status === "paused" || !!facts.treeHasPaused;
  const stopped = status === "stopped";
  const working = !!facts.treeHasLiveWork || status === "running" || status === "starting";
  const live = working || paused || status === "waiting" || status === "watching";
  const type = facts.threadType ?? "chat";
  const rows: MenuRow[] = [];

  if (extra.open) rows.push({ kind: "item", id: "open", label: "Open", icon: Maximize2 });
  if (extra.newPass) rows.push({ kind: "item", id: "new-pass", label: "New pass…", icon: MessageSquarePlus });
  if (queued && (extra.open || extra.newPass)) rows.push({ kind: "item", id: "start-now", label: "Start now", icon: Play });
  // The keyboard's way to the chip drag: split the focused pane and open the thread beside it.
  if (facts.side) rows.push({ kind: "item", id: "side", label: "Open to the side", icon: PanelRight });
  rows.push({ kind: "sep" });

  rows.push({ kind: "item", id: "rename", label: "Rename", icon: Pencil });
  // A retype drops the harness, so a live thread waits until it settles.
  rows.push({
    kind: "sub",
    id: "type",
    label: "Type",
    icon: Layers,
    disabled: live,
    items: THREAD_TYPES.map((each) => ({
      kind: "item",
      id: `type:${each}`,
      label: THREAD_LABELS[each],
      icon: THREAD_GLYPHS[each],
      checked: each === type,
    })),
  });
  if (TUNABLE.has(type)) rows.push({ kind: "item", id: "tune", label: `${THREAD_LABELS[type]} options…`, icon: SlidersHorizontal });
  if (facts.goal !== null) rows.push({ kind: "item", id: "goal", label: "Goal…", icon: Target, checked: facts.goal });
  rows.push({ kind: "sep" });

  if (paused) rows.push({ kind: "item", id: "resume", label: "Continue", icon: Play });
  // The harness is gone: the same resume boots a fresh one on the transcript.
  else if (stopped) rows.push({ kind: "item", id: "resume", label: "Resume", icon: Play });
  else if (working) rows.push({ kind: "item", id: "pause", label: "Pause", icon: Pause });
  // Compact runs as a turn, so only a thread with no turn in flight offers it.
  if (!working && !paused && !stopped && !queued && status !== "waiting")
    rows.push({ kind: "item", id: "compact", label: "Compact", icon: FoldVertical });
  // A watching thread is idle behind its background tasks: this ends them.
  if (status === "watching") rows.push({ kind: "item", id: "killBackground", label: "Kill background tasks", icon: StopCircle, danger: true });
  if (live) rows.push({ kind: "item", id: "stop", label: "Stop", icon: Square, danger: true });
  rows.push({ kind: "sep" });

  if (facts.bridge) {
    const { on, online, inherited, known } = facts.bridge;
    // Inherited from the parent thread: shown on, switched on the parent.
    rows.push({
      kind: "item",
      id: "mac-bridge",
      label: on && !online ? "Mac bridge (offline)" : "Mac bridge",
      icon: Laptop,
      checked: on,
      disabled: !known || inherited,
    });
    if (on) rows.push({ kind: "item", id: "mac-bridge-rules", label: "Mac approvals…", icon: Lock });
  }
  rows.push({ kind: "item", id: "resources", label: "Resources…", icon: Blocks, ...(facts.resources ? { hint: String(facts.resources) } : {}) });
  if (facts.projectId && !facts.parentId) rows.push({ kind: "item", id: "master", label: masterMenuLabel(facts.master), icon: Star });
  rows.push({ kind: "sep" }, ...facts.moves, { kind: "sep" });

  // A queued thread leaves by leaving the queue (the fleet's Stop on a queued root).
  if (queued) rows.push({ kind: "item", id: "remove-queue", label: "Remove from queue", icon: X });
  else rows.push({ kind: "item", id: "archive", label: facts.resources ? "Archive…" : "Archive", icon: Archive });
  rows.push({ kind: "item", id: "delete", label: "Delete…", icon: Trash2, danger: true });
  return tidy(rows);
}
