import { memo, useEffect, useMemo, type ComponentProps } from "react";
import { sameData, useKept } from "../lib/keptValue";
import { resolveSessionContext } from "../lib/projectContext";
import { usePanelRoom, useRightPanel } from "../lib/rightPanel";
import { useWorkspaceCatalog } from "../lib/tcserver/workspaces";
import {
  filterTabsForProjectId,
  filterTabsForWorkspace,
  tabArchived,
} from "../lib/workspaceTabGroups";
import { header, stripOrder, stripOrderStore, useHeldStripModel } from "../stores/header";
import { useStore } from "zustand";
import { dockCwdOf, useProject, useProjectCwds } from "../stores/project";
import { useTerminals } from "../stores/terminals";
import { useWorkspaceTabs } from "../stores/workspace";
import { focusedFileTab, leafIds, type WorkspaceTab } from "../lib/layout";
import { projectName } from "../lib/paths";
import { findProjectTerminal } from "../lib/projectTerminal";
import type { Session } from "../lib/session";
import { useLastSeen, useSeenFloor } from "../lib/sessionSeen";
import {
  sessionStore,
  useSessionMetas,
  useSessionShells,
} from "../lib/tcserver/store";
import type { SessionMeta } from "../lib/tcserver/types";
import {
  buildHeaderModel,
  headerOrder,
  orderModel,
  saveIds,
  stripScopeKey,
  type HeaderTab,
} from "../lib/threadHeaderModel";
import {
  inProjectScope,
  looseScopeOf,
  runningRoots,
  stripRootThreads,
  type StripScope,
} from "../lib/threadStripModel";
import { copiesOf } from "../lib/projectHostChoice";
import { usePlanReady } from "../hooks/usePlanReady";
import type { ThreadHeaderProps } from "./ThreadHeader";
import type { ArchivedThread, ChipThread } from "./ThreadHeaderStrip";
import { TitleBar } from "./TitleBar";

/** The header's handlers; the rest of ThreadHeaderProps is derived here. */
export type HeaderEvents = Pick<
  ThreadHeaderProps,
  | "onSelect"
  | "onRename"
  | "onArchive"
  | "onDelete"
  | "onSetRules"
  | "onRestore"
  | "onNew"
  | "onPauseAll"
  | "onToggleRail"
  | "onSetType"
>;

type StateProps =
  | "header"
  | "activeId"
  | "cwd"
  | "projectTerminalActive"
  | "recents";

type Props = Omit<ComponentProps<typeof TitleBar>, StateProps> & {
  headerEvents: HeaderEvents;
};

/**
 * Owns the title bar's live model — tab chips, thread strip, plan readiness,
 * the active thread's cost — off the stores directly, so a turn starting or
 * ending, a tab switch or a save re-renders this and the memoised TitleBar
 * under it, not App. What App's callbacks need of the projection (the tab
 * order, each tab's project, the header model) is published to the header
 * store after each commit.
 */
function ShellTitleBarComponent({ headerEvents, ...titleBar }: Props) {
  const tabs = useWorkspaceTabs((s) => s.tabs);
  const activeTabId = useWorkspaceTabs((s) => s.activeTabId);
  const projectCwd = useProject((s) => s.projectCwd);
  const selectedProjectId = useProject((s) => s.selectedProjectId);
  const recents = useProject((s) => s.recents);
  const catalog = useWorkspaceCatalog();
  const shells = useSessionShells();
  const { active, sidebarCwd: cwd } = useProjectCwds();
  const activeSessionId = active?.id;
  const panel = useRightPanel(activeSessionId ?? "");
  const railOpen = panel.open;
  const panelRoom = usePanelRoom(activeSessionId ?? "");
  // A linked project's copies are one project here: the strip and its tabs hold every copy's threads.
  const projectScope = useMemo(() => {
    const selected = selectedProjectId ? catalog.projects.find((p) => p.id === selectedProjectId) : undefined;
    const copies = copiesOf(catalog.projects, selected?.linkId);
    return copies.length > 1 ? new Set([selectedProjectId!, ...copies.map((p) => p.id)]) : selectedProjectId;
  }, [catalog.projects, selectedProjectId]);
  const dockCwd = dockCwdOf({ projectCwd, selectedProjectId }, catalog.projects);
  const dock = useTerminals((s) => findProjectTerminal(s.docks, dockCwd));
  const projectTerminalActive = !!dock && dock.pane.files.length > 0;
  const headerWorkspaceId =
    resolveSessionContext({
      ...catalog,
      projectId: selectedProjectId,
      workspacePath: projectCwd,
    }).workspaceId ?? null;
  // The strip shows the selected project's tabs, keyed by server project id.
  // With no project selected it shows this workspace's own loose chats, or
  // on the home the chats outside every workspace.
  const deckTabs = useMemo(() => {
    const open = filterTabsForProjectId(tabs, shells, projectScope).filter(
      (tab) => !tabArchived(tab, shells),
    );
    return selectedProjectId || !catalog.loaded
      ? open
      : filterTabsForWorkspace(open, shells, catalog, headerWorkspaceId);
  }, [catalog, headerWorkspaceId, tabs, shells, selectedProjectId, projectScope]);
  const sessionMetas = useSessionMetas();
  const sessions = useTitleSessions(sessionMetas);
  const lastSeen = useLastSeen();
  const seenFloor = useSeenFloor();
  // The strip is the scope's root threads, open in a tab or not.
  const chipThreads = useMemo(() => chipThreadsOf(sessionMetas, sessions), [sessionMetas, sessions]);
  // The selected project's threads, else the scope's loose chats (every
  // linked copy's).
  const stripScope = useMemo<StripScope>(
    () =>
      selectedProjectId
        ? { project: projectScope }
        : { loose: looseScopeOf(headerWorkspaceId, catalog), catalog },
    [catalog, headerWorkspaceId, projectScope, selectedProjectId],
  );
  // A plan is ready whether or not a tab holds it: the scope's roots and the
  // open sessions (their tabs read it too).
  const planThreads = useMemo(() => {
    const roots = stripRootThreads(chipThreads, stripScope);
    const ids = new Set(roots.map((t) => t.id));
    return [...roots, ...sessions.filter((s) => !ids.has(s.id))];
  }, [chipThreads, sessions, stripScope]);
  const planReady = usePlanReady(planThreads);
  const tabProjects = useMemo(
    () => new Map(deckTabs.map((tab) => [tab.id, tabProjectOf(tab, sessions)])),
    [deckTabs, sessions],
  );
  // The active tab joins even when the scope filtered it out: the thread on
  // screen always has its chip.
  const headerTabs = useMemo<HeaderTab[]>(() => {
    const active = tabs.find((tab) => tab.id === activeTabId && !tabArchived(tab, shells));
    const shown = active && !deckTabs.includes(active) ? [...deckTabs, active] : deckTabs;
    return shown.map((tab) => {
      const ids = leafIds(tab.layout);
      const focused = tab.focusedId;
      return {
        id: tab.id,
        sessionIds:
          focused && ids.includes(focused)
            ? [focused, ...ids.filter((id) => id !== focused)]
            : ids,
      };
    });
  }, [activeTabId, deckTabs, shells, tabs]);
  const builtModel = useMemo(
    () =>
      buildHeaderModel({
        threads: chipThreads,
        tabs: headerTabs,
        scope: stripScope,
        activeTabId,
        lastSeen,
        seenFloor,
        planReady,
      }),
    [activeTabId, chipThreads, headerTabs, lastSeen, seenFloor, planReady, stripScope],
  );
  // The strip keeps a stable order per project, like a browser's tabs.
  const orderKey = stripScopeKey(
    selectedProjectId ? catalog.projects.find((p) => p.id === selectedProjectId) : undefined,
    headerWorkspaceId,
  );
  const savedOrder = useStore(stripOrderStore, (s) => s.order[orderKey]?.ids);
  const headerModel = useMemo(
    () => orderModel(builtModel, savedOrder ?? []),
    [builtModel, savedOrder],
  );
  useEffect(() => {
    stripOrder.set(orderKey, saveIds(headerModel));
  }, [headerModel, orderKey]);
  // The saved order above never takes a held chip.
  // The model and the shelf keep their identity while they read the same:
  // they are rebuilt from every meta push, and the whole title bar re-rendered.
  const stripModel = useKept(useHeldStripModel(headerModel), sameData);
  const stripTabs = useMemo(() => {
    const chipTabIds = new Set(
      headerOrder(stripModel).flatMap((chip) => (chip.tabId ? [chip.tabId] : [])),
    );
    return [
      ...chipTabIds,
      ...deckTabs.filter((tab) => !chipTabIds.has(tab.id)).map((tab) => tab.id),
    ];
  }, [deckTabs, stripModel]);
  useEffect(() => {
    header.publish({ tabProjects, stripTabs, model: stripModel, chipThreads });
  }, [chipThreads, stripModel, stripTabs, tabProjects]);

  // The live list leaves archived threads out; the shelf asks for the
  // selected project's own when it is shown.
  useEffect(() => {
    if (!projectScope) return;
    for (const p of catalog.projects)
      if (inProjectScope(p.id, projectScope)) void sessionStore.ensureArchived(p.environmentId, p.id);
  }, [catalog.projects, projectScope]);
  /** The selected project's archived roots, freshest first, for the shelf. */
  const archivedNext = useMemo<ArchivedThread[]>(() => {
    if (!projectScope) return [];
    return sessionMetas
      .filter(
        (meta) =>
          meta.archived && !meta.parentId && inProjectScope(meta.projectId, projectScope),
      )
      .map((meta) => ({
        id: meta.id,
        title: meta.title,
        type: meta.threadType,
        updatedAt: meta.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [projectScope, sessionMetas]);
  const archivedThreads = useKept(archivedNext, sameData);

  const cost = sessions.find((session) => session.id === activeSessionId)?.thread?.cost ?? null;
  const running = useMemo(
    () => runningRoots(stripRootThreads(chipThreads, stripScope)).length,
    [chipThreads, stripScope],
  );
  const headerProps = useMemo<ThreadHeaderProps>(
    () => ({
      model: stripModel,
      planReady,
      archived: archivedThreads,
      workspaceId: headerWorkspaceId,
      cost,
      running,
      railOpen,
      panelRoom,
      ...headerEvents,
    }),
    [archivedThreads, cost, headerEvents, headerWorkspaceId, panelRoom, planReady, railOpen, running, stripModel],
  );

  return (
    <TitleBar
      {...titleBar}
      header={headerProps}
      activeId={activeTabId}
      cwd={cwd}
      projectTerminalActive={projectTerminalActive}
      recents={recents}
    />
  );
}

export const ShellTitleBar = memo(ShellTitleBarComponent);

/**
 * The open sessions, re-read only when a shell or a meta changes. Every
 * field the title bar shows (busy, status, activity, tasks, title, cost)
 * moves with a meta push; the snapshot itself is a new array on every
 * streamed event, and reading it as state re-ran every derivation here
 * once per frame while any thread streamed.
 */
function useTitleSessions(metas: readonly SessionMeta[]): Session[] {
  const shells = useSessionShells();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- shells and metas are the change signal
  return useMemo(() => sessionStore.getSnapshot(), [shells, metas]);
}

/** The project folder a tab belongs to: its focused thread's, else its
 *  focused file's, else "~". App's callbacks read it from the header store. */
function tabProjectOf(tab: WorkspaceTab, sessions: readonly Session[]): string {
  const byId = (id: string | undefined) => sessions.find((session) => session.id === id);
  const focused = byId(tab.focusedId) ?? leafIds(tab.layout).map(byId).find(Boolean);
  if (focused) return projectName(focused.cwd);
  const file = focusedFileTab(tab);
  return file ? projectName(file.cwd) : "~";
}

/**
 * The threads the strip may draw: every meta, plus a sent local thread whose
 * create is still in flight (it joins with its first row and the meta takes
 * over when it lands). An unsent draft is never a chip: the centred composer
 * says where the person is.
 */
export function chipThreadsOf(
  sessionMetas: readonly ChipThread[],
  sessions: readonly Session[],
): readonly ChipThread[] {
  const known = new Set(sessionMetas.map((meta) => meta.id));
  const drafts = sessions
    .filter((session) => !known.has(session.id) && session.blocks.length > 0)
    .map(
      (session): ChipThread => ({
        id: session.id,
        environmentId: session.environmentId,
        title: session.title,
        threadType: session.threadType ?? null,
        provider: session.harness,
        projectId: session.projectId ?? null,
        workspaceId: session.workspaceId ?? null,
        cwd: session.cwd,
        parentId: session.parentId ?? null,
        archived: false,
        status: "idle",
        updatedAt: session.createdAt ?? 0,
        draft: true,
        threadRules: session.threadRules ?? null,
      }),
    );
  return drafts.length > 0 ? [...sessionMetas, ...drafts] : sessionMetas;
}
