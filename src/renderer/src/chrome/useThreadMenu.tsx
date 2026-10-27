import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { devPane, useDevPane } from "../lib/devPane";
import { useDevRunning, useDevServable } from "../lib/devServers";
import { bridgeableEnvironment, loadThreadBridge, setThreadBridge, useThreadBridge } from "../lib/macBridge";
import { useMasterIds } from "../lib/masterThread";
import * as commands from "../lib/tcserver/commands";
import { sessionStore } from "../lib/tcserver/store";
import { useProjects } from "../lib/tcserver/workspaces";
import type { ThreadRules } from "@server/shared/rules";
import type { SessionMeta, ThreadType } from "../lib/tcserver/types";
import { threadMenuRows, type ThreadMenuExtra } from "../lib/threadMenu";
import { archiveThread, isRemovable, liveResources, loadThreadResources, startThreadResources, useThreadResources } from "../lib/threadResources";
import { leafIds } from "../lib/layout";
import { shortcutFor } from "../lib/settings";
import { workspaceTabsStore } from "../stores/workspace";
import { workspaceActions } from "../stores/workspaceActions";
import { SessionActionsContext } from "../surfaces/threadChat";
import { RenameThreadDialog } from "../surfaces/threads/master/RenameThreadDialog";
import { THREAD_LABELS } from "../surfaces/threads/threadTypes";
import { ConfirmDialog } from "./ConfirmDialog";
import { goalDialog } from "./GoalDialog";
import { MacBridgeRulesDialog } from "./MacBridgeRulesDialog";
import type { MenuRow } from "./menuRows";
import { useThreadHost } from "./ThreadHostChip";
import { ArchiveThreadDialog, ThreadResourcesDialog } from "./ThreadResourcesDialog";
import { TuneDialog } from "./ThreadTune";

/**
 * The one place a thread menu's picks happen and its dialogs mount
 * (lib/threadMenu.ts is the list). A surface gives `rowsFor` to its
 * `RowsMenu` or `RowsContextMenu`, calls `onOpenChange` when the menu opens
 * (that loads the Mac bridge's state and the resources the rows read, and
 * names the thread whose host moves and dialogs follow), routes `onPick`,
 * and renders `dialogs` once.
 *
 * Rename is the surface's (inline on the tab and the rail); without an
 * `onRename` it opens RenameThreadDialog. Archive and Delete confirm here,
 * then call the surface's handler (App's, which also discards a draft tab),
 * or archive and delete themselves.
 */
export type ThreadMenuHandlers = {
  onRename?: (id: string) => void;
  onOpen?: (id: string) => void;
  onNewPass?: (id: string) => void;
  onArchive?: (id: string) => void;
  onDelete?: (id: string) => void;
  /** The Type rows (App's onThreadTypeChange); the chat's context by default. */
  onSetType?: (id: string, threadType: ThreadType) => void;
  /** The options dialog's save (App's, which also updates its own copy). */
  onSetRules?: (id: string, rules: ThreadRules | null) => void;
  /** Whether the thread's composer is on screen to answer Goal…. */
  onScreen?: (id: string) => boolean;
  /** A thread the surface knows before the store does (a board row the host's answer named). */
  metaFor?: (id: string) => SessionMeta | null;
};

export type ThreadMenuApi = {
  rowsFor: (id: string, extra?: ThreadMenuExtra) => MenuRow[];
  onOpenChange: (id: string | null, open: boolean) => void;
  onPick: (id: string, pick: string) => void;
  dialogs: ReactNode;
};

/** The harnesses that keep a goal (claude /goal, codex thread/goal/set). */
const GOAL_HARNESSES: ReadonlySet<string> = new Set(["claude", "codex"]);

type Dialog = { kind: "tune" | "delete" | "bridge" | "resources" | "archive" | "rename"; id: string };

/** The focused pane of the tab on screen, when it is not this thread's own. */
function sidePane(id: string): string | null {
  const state = workspaceTabsStore.getState();
  const pane = state.tabs.find((tab) => tab.id === state.activeTabId)?.focusedId ?? null;
  return pane && pane !== id ? pane : null;
}

/** Close tab's fact: the thread has an open tab; split when it shares it, ⌘W's caps when it is the focused pane. */
function closeFact(id: string): { split: boolean; shortcut?: string } | undefined {
  const state = workspaceTabsStore.getState();
  const tab = state.tabs.find((t) => leafIds(t.layout).includes(id));
  if (!tab) return undefined;
  const focused = state.activeTabId === tab.id && tab.focusedId === id;
  return { split: leafIds(tab.layout).length > 1, ...(focused ? { shortcut: shortcutFor("Panes", "Close") } : {}) };
}

function titleOf(id: string): string {
  return (sessionStore.get(id)?.title ?? sessionStore.metaOf(id)?.title) || "Untitled";
}

/** The Dev server row (docs/box.md "Dev servers on the box"): offered when a
 *  host can serve the thread's project or one of its servers runs; it opens
 *  and closes the Dev servers pane and never starts anything. */
export function useThreadDevServer(sessionId: string | null): { open: boolean } | null {
  // The thread's project and host only: a streaming turn must not re-render the menu's owner.
  const where = useSyncExternalStore(sessionStore.subscribe, () => {
    const t = sessionId ? (sessionStore.get(sessionId) ?? sessionStore.metaOf(sessionId)) : undefined;
    return t?.projectId ? `${t.environmentId}|${t.projectId}` : "";
  });
  const [environmentId, projectId] = where.split("|");
  const project = useProjects().find((p) => p.id === projectId && p.environmentId === environmentId);
  const servable = useDevServable(project);
  const running = useDevRunning(project?.id);
  const open = useDevPane((s) => s.open);
  return project && (servable || running) ? { open } : null;
}

export function useThreadMenu(handlers: ThreadMenuHandlers = {}): ThreadMenuApi {
  const latest = useRef(handlers);
  latest.current = handlers;
  const actions = useContext(SessionActionsContext);
  const metaOf = (id: string): SessionMeta | null => sessionStore.metaOf(id) ?? latest.current.metaFor?.(id) ?? null;
  // The thread the menu was last opened for: its bridge, resources and moves.
  const [target, setTarget] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const bridgeState = useThreadBridge(target ?? undefined);
  const resources = useThreadResources(target ?? undefined);
  const host = useThreadHost(target);
  const dev = useThreadDevServer(target);
  const masterIds = useMasterIds();
  useEffect(() => startThreadResources(), []);

  const rowsFor = (id: string, extra?: ThreadMenuExtra): MenuRow[] => {
    const session = sessionStore.get(id);
    const meta = session ? null : metaOf(id);
    const t = session ?? meta;
    if (!t) return [];
    const own = id === target;
    const environmentId = t.environmentId;
    const goal =
      !t.parentId && GOAL_HARNESSES.has(session?.harness ?? meta?.provider ?? "") && latest.current.onScreen?.(id) ? !!session?.goal : null;
    return threadMenuRows(
      {
        status: t.status ?? "idle",
        treeHasLiveWork: session?.treeHasLiveWork,
        treeHasPaused: session?.treeHasPaused,
        threadType: t.threadType ?? null,
        projectId: t.projectId ?? null,
        parentId: t.parentId ?? null,
        master: masterIds.has(id),
        resources: own ? resources.length : 0,
        removable: own ? resources.filter(isRemovable).length : 0,
        goal,
        bridge:
          own && bridgeableEnvironment(environmentId)
            ? { on: !!bridgeState?.macPeer, online: !!bridgeState?.online, inherited: !!bridgeState?.inherited, known: !!bridgeState }
            : undefined,
        moves: own ? host.moves : [],
        side: !!sidePane(id),
        close: actions?.onCloseTab ? closeFact(id) : undefined,
        dev: own ? dev : null,
      },
      extra,
    );
  };

  const onOpenChange = useCallback((id: string | null, open: boolean) => {
    if (!open || !id) return;
    setTarget(id);
    const env = sessionStore.get(id)?.environmentId ?? sessionStore.metaOf(id)?.environmentId;
    if (env && bridgeableEnvironment(env)) void loadThreadBridge(env, id);
    void loadThreadResources(id);
  }, []);

  const quiet = (run: Promise<unknown>) => void run.catch((err) => console.warn("[thread-menu]", err));
  const onPick = (id: string, pick: string) => {
    const h = latest.current;
    if (id === target && host.pick(pick)) return;
    if (pick.startsWith("type:")) {
      const type = pick.slice("type:".length) as ThreadType;
      if (h.onSetType) h.onSetType(id, type);
      else if (actions) actions.onThreadTypeChange(id, type);
      else quiet(commands.retype(id, type));
    } else if (pick === "rename") (h.onRename ? h.onRename(id) : setDialog({ kind: "rename", id }));
    else if (pick === "open") h.onOpen?.(id);
    else if (pick === "close-tab") actions?.onCloseTab?.(id);
    else if (pick === "side") {
      const pane = sidePane(id);
      if (pane) workspaceActions.dropThread(id, pane, "right");
    }
    else if (pick === "new-pass") h.onNewPass?.(id);
    else if (pick === "tune") setDialog({ kind: "tune", id });
    else if (pick === "goal") goalDialog.open(id);
    else if (pick === "pause") quiet(commands.pause(id));
    else if (pick === "resume") quiet(commands.resume(id));
    else if (pick === "compact") quiet(commands.compact(id));
    else if (pick === "killBackground") quiet(commands.killBackground(id));
    else if (pick === "stop") quiet(commands.interrupt(id));
    else if (pick === "start-now") quiet(commands.startNow(id));
    else if (pick === "master") quiet(commands.setMaster(id, !masterIds.has(id)));
    else if (pick === "mac-bridge") {
      const env = sessionStore.get(id)?.environmentId ?? sessionStore.metaOf(id)?.environmentId;
      if (env) quiet(setThreadBridge(env, id, !bridgeState?.macPeer));
    } else if (pick === "mac-bridge-rules") setDialog({ kind: "bridge", id });
    else if (pick === "resources") setDialog({ kind: "resources", id });
    else if (pick === "dev") devPane.toggle();
    else if (pick === "remove-queue") {
      const env = metaOf(id)?.environmentId ?? sessionStore.get(id)?.environmentId;
      if (env) quiet(commands.sessionBatch(env, "stop", [id]));
    }
    // With resources on the ledger the archive asks whether they go too.
    else if (pick === "archive") {
      if (liveResources(id).length) setDialog({ kind: "archive", id });
      else if (h.onArchive) h.onArchive(id);
      else quiet(archiveThread(id));
    } else if (pick === "delete") setDialog({ kind: "delete", id });
  };

  const close = () => setDialog(null);
  const session = dialog ? sessionStore.get(dialog.id) : undefined;
  let dialogs: ReactNode = null;
  if (dialog?.kind === "rename") {
    dialogs = <RenameThreadDialog sessionId={dialog.id} title={titleOf(dialog.id)} onClose={close} />;
  } else if (dialog?.kind === "tune" && session) {
    const id = dialog.id;
    dialogs = (
      <TuneDialog
        environmentId={session.environmentId}
        title={`${THREAD_LABELS[session.threadType ?? "chat"]} options`}
        thread={titleOf(id)}
        initial={session.threadRules}
        workspaceId={session.workspaceId ?? null}
        onCancel={close}
        onSave={(rules) => {
          close();
          const save = latest.current.onSetRules;
          if (save) save(id, rules);
          else quiet(commands.setThreadRules(id, rules));
        }}
      />
    );
  } else if (dialog?.kind === "bridge") {
    dialogs = <MacBridgeRulesDialog sessionId={dialog.id} title={titleOf(dialog.id)} onClose={close} />;
  } else if (dialog?.kind === "resources") {
    dialogs = <ThreadResourcesDialog sessionId={dialog.id} title={titleOf(dialog.id)} onClose={close} />;
  } else if (dialog?.kind === "archive") {
    dialogs = (
      <ArchiveThreadDialog sessionId={dialog.id} title={titleOf(dialog.id)} resources={liveResources(dialog.id)} onCancel={close} onArchived={close} />
    );
  } else if (dialog?.kind === "delete") {
    const id = dialog.id;
    dialogs = (
      <ConfirmDialog
        title={`Delete ${titleOf(id)}?`}
        body="The thread and its whole transcript are gone for good. Archive keeps it instead."
        confirmLabel="Delete thread"
        danger
        onCancel={close}
        onConfirm={() => {
          close();
          const h = latest.current;
          if (h.onDelete) h.onDelete(id);
          else quiet(commands.remove(id));
        }}
      />
    );
  }

  return {
    rowsFor,
    onOpenChange,
    onPick,
    dialogs: (
      <>
        {host.dialog}
        {dialogs}
      </>
    ),
  };
}
