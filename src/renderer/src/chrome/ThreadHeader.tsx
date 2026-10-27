import { sessionStore } from "../lib/tcserver/store";
import { bridgeableEnvironment, loadThreadBridge, setThreadBridge, useThreadBridge } from "../lib/macBridge";
import type { MacBridgeThreadState } from "@server/shared/contract-macbridge";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ThreadRules } from "@server/shared/rules";
import type { ThreadType } from "../lib/tcserver/types";
import type { HeaderModel } from "../lib/threadHeaderModel";
import type { ReadyMap } from "../lib/threadStripModel";
import { THREAD_LABELS, THREAD_TYPES } from "../surfaces/threads/threadTypes";
import type { ExplorerMenuItem } from "./ExplorerMenu";
import { NewThreadChooser } from "./NewThreadChooser";
import { ProjectPlanChip } from "./ProjectPlanChip";
import { ConfirmDialog } from "./ProjectDialogs";
import { ThreadHeaderStrip, chipTitle, type ArchivedThread, type ChipThread, type StripChip } from "./ThreadHeaderStrip";
import { MenuRows, ThreadMenu, type ThreadMenuItem } from "./ThreadMenu";
import { TuneDialog } from "./ThreadTune";
import { MacBridgeRulesDialog } from "./MacBridgeRulesDialog";
import { ArchiveThreadDialog, ThreadResourcesDialog } from "./ThreadResourcesDialog";
import { liveResources, loadThreadResources, startThreadResources, useThreadResources } from "../lib/threadResources";
import { useThreadHost } from "./ThreadHostChip";
import { devPane, useDevPane } from "../lib/devPane";
import { useDevRunning, useDevServable } from "../lib/devServers";
import { useProjects } from "../lib/tcserver/workspaces";
import { masterMenuLabel, useMasterIds } from "../lib/masterThread";
import { setMaster } from "../lib/tcserver/commands";

/**
 * The deck title bar's thread surface: temp-code's strip and heading
 * controls inside MonoCode's shell. Owns the chip menu, inline rename, the
 * tune and delete dialogs, Pause all and the panel toggle; every action goes
 * back to App by thread id.
 */

export type ThreadAction = "pause" | "resume" | "stop" | "compact" | "killBackground";

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
  /** The thread menu's Type rows (App's onThreadTypeChange). */
  onSetType: (id: string, threadType: ThreadType) => void;
};

const TUNABLE: ReadonlySet<ThreadType> = new Set(["orchestration", "research"]);

/** The Mac bridge's switch for a thread on another host (lib/macBridge.ts); absent for this Mac's own threads. */
export type ChipBridge = { state: MacBridgeThreadState | null };

export function chipMenuItems(
  chip: StripChip,
  bridge?: ChipBridge,
  resources = 0,
  master = false,
  /** The thread's "Move to <host>…" rows (useThreadHost), before Archive. */
  moves: readonly ExplorerMenuItem[] = [],
): ThreadMenuItem[] {
  const t = chip.thread;
  const items: ThreadMenuItem[] = [{ kind: "item", id: "rename", label: "Rename" }];
  if (t.threadType && TUNABLE.has(t.threadType))
    items.push({ kind: "item", id: "tune", label: `${THREAD_LABELS[t.threadType]} options…` });
  const paused = chip.status === "paused" || !!t.treeHasPaused;
  const stopped = chip.status === "stopped";
  const working = !!t.treeHasLiveWork || chip.status === "running" || chip.status === "starting";
  const live = working || paused || chip.status === "waiting" || chip.status === "watching";
  // The type, here once the composer's picker has left (a thread with a message).
  // A retype drops the harness, so a live thread waits until it settles.
  const type = t.threadType ?? "chat";
  items.splice(1, 0, {
    kind: "sub",
    id: "type",
    label: "Type",
    disabled: live,
    items: THREAD_TYPES.map((each) => ({ kind: "item", id: `type:${each}`, label: THREAD_LABELS[each], checked: each === type })),
  });
  if (paused) items.push({ kind: "item", id: "resume", label: "Continue" });
  // The harness is gone: the same resume boots a fresh one on the transcript.
  else if (stopped) items.push({ kind: "item", id: "resume", label: "Resume" });
  else if (working) items.push({ kind: "item", id: "pause", label: "Pause" });
  // Compact squeezes the transcript in place; it runs as a turn, so only
  // a thread with no turn in flight offers it.
  if (!working && !paused && !stopped && chip.status !== "waiting")
    items.push({ kind: "item", id: "compact", label: "Compact" });
  // A watching thread is idle behind its background tasks: this kills
  // them (the harness goes with them) and the row settles idle.
  if (chip.status === "watching")
    items.push({ kind: "item", id: "killBackground", label: "Kill background tasks", danger: true });
  if (live) items.push({ kind: "item", id: "stop", label: "Stop", danger: true });
  if (bridge) {
    // Inherited from the parent thread: shown on, switched on the parent.
    const on = !!bridge.state?.macPeer;
    const offline = on && !bridge.state?.online ? " (offline)" : "";
    items.push(
      { kind: "sep" },
      { kind: "item", id: "mac-bridge", label: `Mac bridge${offline}`, checked: on, disabled: !bridge.state || bridge.state.inherited },
    );
    if (on) items.push({ kind: "item", id: "mac-bridge-rules", label: "Mac approvals…" });
  }
  // What the thread created (worktrees, simulators, dev instances), with Remove per row.
  items.push({ kind: "sep" }, { kind: "item", id: "resources", label: resources ? `Resources (${resources})…` : "Resources…" });
  // A master thread (CLAUDE.md "Master threads"): any root in a project, as many as the person wants.
  if (t.projectId && !t.parentId) items.push({ kind: "item", id: "master", label: masterMenuLabel(master) });
  if (moves.length) items.push({ kind: "sep" }, ...moves);
  items.push({ kind: "sep" }, { kind: "item", id: "archive", label: resources ? "Archive…" : "Archive" });
  items.push({ kind: "sep" }, { kind: "item", id: "delete", label: "Delete…", danger: true });
  return items;
}

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
  // The thread a menu was last opened for: its right-click, or the ⋯ menu's active thread.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [tuning, setTuning] = useState<StripChip | null>(null);
  const tuningSession = tuning ? sessionStore.get(tuning.id) : undefined;
  const [deleting, setDeleting] = useState<StripChip | null>(null);
  const [bridgeRules, setBridgeRules] = useState<StripChip | null>(null);
  const [resourcesFor, setResourcesFor] = useState<StripChip | null>(null);
  const [archiving, setArchiving] = useState<StripChip | null>(null);
  useEffect(() => startThreadResources(), []);

  const loadMenu = useCallback((id: string) => {
    setMenuFor(id);
    const env = sessionStore.get(id)?.environmentId;
    if (env && bridgeableEnvironment(env)) void loadThreadBridge(env, id);
    void loadThreadResources(id);
  }, []);
  const onContextMenu = useCallback((chip: StripChip) => loadMenu(chip.id), [loadMenu]);
  const target = menuFor ?? model.activeId;
  const targetEnv = target ? sessionStore.get(target)?.environmentId : undefined;
  const bridgeState = useThreadBridge(target ?? undefined);
  const resources = useThreadResources(target ?? undefined);
  const host = useThreadHost(target);
  const masterIds = useMasterIds();
  const dev = useDevServer(model.activeId);
  const activeChip = model.live.find((c) => c.id === model.activeId) ?? null;

  /** The one list for a thread: its chip's right-click and the ⋯ menu alike. */
  const rowsFor = (chip: StripChip): ThreadMenuItem[] => {
    const own = chip.id === target;
    const bridge: ChipBridge | undefined =
      own && targetEnv && bridgeableEnvironment(targetEnv) ? { state: bridgeState } : undefined;
    return chipMenuItems(chip, bridge, own ? resources.length : 0, masterIds.has(chip.id), own ? host.moves : []);
  };

  const pick = (chip: StripChip, id: string) => {
    if (host.pick(id)) return;
    if (id.startsWith("type:")) onSetType(chip.id, id.slice("type:".length) as ThreadType);
    else if (id === "rename") setRenamingId(chip.id);
    else if (id === "tune") setTuning(chip);
    // With resources on the ledger the archive asks whether they go too (ArchiveThreadDialog).
    else if (id === "archive") (liveResources(chip.id).length ? setArchiving(chip) : onArchive(chip.id));
    else if (id === "resources") setResourcesFor(chip);
    else if (id === "master") void setMaster(chip.id, !masterIds.has(chip.id)).catch((err) => console.warn("[master]", err));
    else if (id === "delete") setDeleting(chip);
    else if (id === "mac-bridge-rules") setBridgeRules(chip);
    else if (id === "mac-bridge") {
      const env = sessionStore.get(chip.id)?.environmentId;
      if (env) void setThreadBridge(env, chip.id, !bridgeState?.macPeer).catch((err) => console.warn("[mac-bridge]", err));
    }
    else onAction(chip.id, id as ThreadAction);
  };

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
        onContextMenu={onContextMenu}
        menu={(chip) => <MenuRows kind="context" items={rowsFor(chip)} onPick={(id) => pick(chip, id)} />}
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
            host={activeChip && model.activeId === target ? host.host : null}
            cost={cost}
            rows={activeChip ? rowsFor(activeChip) : []}
            onPick={(id) => activeChip && pick(activeChip, id)}
            onOpen={() => model.activeId && loadMenu(model.activeId)}
            running={running}
            onPauseAll={onPauseAll}
            dev={dev}
            terminal={{ onShow: onShowTerminal, onNew: onNewTerminal, active: projectTerminalActive }}
            recent={model.dormant}
            onOpenRecent={onSelect}
            archived={archived}
            onRestore={onRestore}
            panel={{ open: railOpen, onToggle: onToggleRail }}
          />
        }
      />
      {host.dialog}
      {tuning && tuningSession ? (
        <TuneDialog
          environmentId={tuningSession.environmentId}
          title={`${THREAD_LABELS[tuning.thread.threadType ?? "chat"]} options · ${chipTitle(tuning)}`}
          initial={tuning.thread.threadRules}
          workspaceId={tuningSession.workspaceId ?? null}
          onCancel={() => setTuning(null)}
          onSave={(rules) => {
            setTuning(null);
            onSetRules(tuning.id, rules);
          }}
        />
      ) : null}
      {bridgeRules ? (
        <MacBridgeRulesDialog sessionId={bridgeRules.id} title={chipTitle(bridgeRules)} onClose={() => setBridgeRules(null)} />
      ) : null}
      {resourcesFor ? (
        <ThreadResourcesDialog sessionId={resourcesFor.id} title={chipTitle(resourcesFor)} onClose={() => setResourcesFor(null)} />
      ) : null}
      {archiving ? (
        <ArchiveThreadDialog
          sessionId={archiving.id}
          title={chipTitle(archiving)}
          resources={liveResources(archiving.id)}
          onCancel={() => setArchiving(null)}
          onArchived={() => setArchiving(null)}
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
