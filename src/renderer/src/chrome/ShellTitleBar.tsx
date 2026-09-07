import { memo, useMemo, useRef, type ComponentProps, type MutableRefObject } from "react";
import { basename } from "../lib/fs";
import {
  focusedFileTab,
  isFilesystemTab,
  isTerminalTab,
  leafIds,
  type FilePaneTab,
  type WorkspaceTab,
} from "../lib/layout";
import { projectName } from "../lib/paths";
import { releaseNotesTitle } from "../lib/releaseNotes";
import {
  hasPendingApproval,
  sessionDisplayTitle,
  type HarnessId,
  type Session,
} from "../lib/session";
import { useLastSeen } from "../lib/sessionSeen";
import {
  sessionStore,
  useServerSessions,
  useSessionMetas,
} from "../lib/tcserver/store";
import { terminalTabLabel } from "../lib/terminalTab";
import {
  buildHeaderModel,
  headerOrder,
  type HeaderModel,
  type HeaderTab,
} from "../lib/threadHeaderModel";
import { projectRootThreads, runningRoots } from "../lib/threadStripModel";
import { usePlanReady } from "../hooks/usePlanReady";
import { turnStartOf } from "../surfaces/threads/WorkingStrip";
import type { TabThread } from "./TabIndicator";
import type { ThreadHeaderProps } from "./ThreadHeader";
import type { ArchivedThread, ChipThread } from "./ThreadHeaderStrip";
import { TitleBar, type Tab as TitleTab } from "./TitleBar";

/** The header's handlers; the rest of ThreadHeaderProps is derived here. */
export type HeaderEvents = Pick<
  ThreadHeaderProps,
  | "onSelect"
  | "onRename"
  | "onArchive"
  | "onDelete"
  | "onAction"
  | "onSetRules"
  | "onRestore"
  | "onNew"
  | "onPauseAll"
  | "onToggleRail"
>;

type Props = Omit<ComponentProps<typeof TitleBar>, "tabs" | "header"> & {
  /** The tabs the strip shows (deck mode: the selected project's). */
  deckTabs: WorkspaceTab[];
  dirtyFiles: Set<string>;
  selectedProjectId: string | null;
  activeSessionId?: string;
  /** The selected project's workspace, for the header's tune defaults. */
  headerWorkspaceId: string | null;
  railOpen: boolean;
  /** Present in deck mode; absent renders the classic strip. */
  headerEvents?: HeaderEvents;
  /** Tab id -> project name, read by App's tab-group callbacks. */
  tabProjectsRef: MutableRefObject<Map<string, string>>;
  /** Tab ids in strip order, read by App's tab cycling. */
  stripTabsRef: MutableRefObject<string[]>;
  headerModelRef: MutableRefObject<HeaderModel<ChipThread>>;
  chipThreadsRef: MutableRefObject<ChipThread[]>;
};

/**
 * Owns the title bar's live model — tab chips, thread strip, plan readiness,
 * the active thread's cost — off the store directly, so a turn starting or
 * ending re-renders this and the memoised TitleBar under it, not App.
 */
function ShellTitleBarComponent({
  deckTabs,
  dirtyFiles,
  selectedProjectId,
  activeSessionId,
  headerWorkspaceId,
  railOpen,
  headerEvents,
  tabProjectsRef,
  stripTabsRef,
  headerModelRef,
  chipThreadsRef,
  ...titleBar
}: Props) {
  const deckLayout = !!titleBar.deckLayout;
  const { activeId: activeTabId } = titleBar;
  const sessions = useServerSessions();
  const sessionMetas = useSessionMetas();
  const planReady = usePlanReady(sessions);
  const lastSeen = useLastSeen();
  const nextTitleTabs: TitleTab[] = deckTabs.map((tab) =>
    toTitleTab(tab, sessions, dirtyFiles, planReady),
  );
  tabProjectsRef.current = new Map(nextTitleTabs.map((tab) => [tab.id, tab.project]));
  // The strip is the selected project's root threads, open in a tab or not;
  // a local draft joins until the server knows it.
  const chipThreads = useMemo<ChipThread[]>(() => {
    const known = new Set(sessionMetas.map((meta) => meta.id));
    const drafts = sessions
      .filter((session) => session.projectId && !known.has(session.id))
      .map(
        (session): ChipThread => ({
          id: session.id,
          title: session.title,
          threadType: session.threadType ?? null,
          provider: session.harness,
          projectId: session.projectId ?? null,
          parentId: session.parentId ?? null,
          archived: false,
          status: "idle",
          updatedAt: session.createdAt ?? 0,
          draft: true,
          threadRules: session.threadRules ?? null,
        }),
      );
    return drafts.length > 0 ? [...sessionMetas, ...drafts] : sessionMetas;
  }, [sessionMetas, sessions]);
  chipThreadsRef.current = chipThreads;
  const headerTabs = useMemo<HeaderTab[]>(
    () =>
      deckTabs.map((tab) => {
        const ids = leafIds(tab.layout);
        const focused = tab.focusedId;
        return {
          id: tab.id,
          sessionIds:
            focused && ids.includes(focused)
              ? [focused, ...ids.filter((id) => id !== focused)]
              : ids,
        };
      }),
    [deckTabs],
  );
  const headerModel = useMemo(
    () =>
      buildHeaderModel({
        threads: chipThreads,
        tabs: headerTabs,
        selectedProjectId: deckLayout ? selectedProjectId : null,
        activeTabId,
        lastSeen,
        planReady,
      }),
    [activeTabId, chipThreads, deckLayout, headerTabs, lastSeen, planReady, selectedProjectId],
  );
  headerModelRef.current = headerModel;
  const chipTabIds = new Set(
    headerOrder(headerModel).flatMap((chip) => (chip.tabId ? [chip.tabId] : [])),
  );
  stripTabsRef.current = deckLayout
    ? [...chipTabIds, ...deckTabs.filter((tab) => !chipTabIds.has(tab.id)).map((tab) => tab.id)]
    : nextTitleTabs.map((tab) => tab.id);

  /** The selected project's archived roots, freshest first, for the shelf. */
  const archivedThreads = useMemo<ArchivedThread[]>(() => {
    if (!deckLayout || !selectedProjectId) return [];
    return sessionMetas
      .filter(
        (meta) =>
          meta.archived && !meta.parentId && meta.projectId === selectedProjectId,
      )
      .map((meta) => ({
        id: meta.id,
        title: meta.title,
        type: meta.threadType,
        updatedAt: meta.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [deckLayout, selectedProjectId, sessionMetas]);

  const cost = sessions.find((session) => session.id === activeSessionId)?.thread?.cost ?? null;
  const running = runningRoots(projectRootThreads(chipThreads, selectedProjectId)).length;
  const header = useMemo<ThreadHeaderProps | undefined>(
    () =>
      deckLayout && headerEvents
        ? {
            model: headerModel,
            planReady,
            archived: archivedThreads,
            workspaceId: headerWorkspaceId,
            cost,
            running,
            railOpen,
            ...headerEvents,
          }
        : undefined,
    [archivedThreads, cost, deckLayout, headerEvents, headerModel, headerWorkspaceId, planReady, railOpen, running],
  );

  const titleTabsRef = useRef(nextTitleTabs);
  if (!titleTabsEqual(titleTabsRef.current, nextTitleTabs)) {
    titleTabsRef.current = nextTitleTabs;
  }
  return <TitleBar {...titleBar} tabs={titleTabsRef.current} header={header} />;
}

export const ShellTitleBar = memo(ShellTitleBarComponent);

function titleTabsEqual(a: TitleTab[], b: TitleTab[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((tab, index) => {
    const other = b[index];
    return (
      other != null &&
      tab.id === other.id &&
      tab.project === other.project &&
      tab.title === other.title &&
      tab.sessionCount === other.sessionCount &&
      tab.dirty === other.dirty &&
      tab.more.join("\u0000") === other.more.join("\u0000") &&
      tab.harnesses.join("\u0000") === other.harnesses.join("\u0000") &&
      tab.busyHarnesses.join("\u0000") === other.busyHarnesses.join("\u0000") &&
      tab.files.join("\u0000") === other.files.join("\u0000") &&
      tab.multiPane === other.multiPane &&
      tab.fileFocused === other.fileFocused &&
      tab.terminal === other.terminal &&
      tab.groupId === other.groupId &&
      tab.updatedAt === other.updatedAt &&
      sameTabThread(tab.thread, other.thread)
    );
  });
}

function conversationTitle(session: Session): string {
  const title = sessionDisplayTitle(session.title, session.harness);
  return title === "New session" ? "" : title;
}

/** The focused thread's live state for the tab edge; absent for drafts with no type. */
function tabThreadOf(session: Session | undefined, planReady: Record<string, boolean>): TabThread | undefined {
  if (!session || !session.threadType) return undefined;
  const status = session.status ?? (session.busy ? "running" : "idle");
  return {
    type: session.threadType,
    status,
    since: turnStartOf(session) ?? 0,
    activity: session.activity ?? null,
    activityKind: session.activityKind ?? null,
    tasks: session.tasks ? { done: session.tasks.done, total: session.tasks.total } : null,
    planReady: !!planReady[session.id],
    frozenElapsed: session.frozenActiveElapsed ?? null,
  };
}

function sameTabThread(a: TabThread | undefined, b: TabThread | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.type === b.type &&
    a.status === b.status &&
    a.since === b.since &&
    a.activity === b.activity &&
    a.activityKind === b.activityKind &&
    (a.tasks?.done ?? -1) === (b.tasks?.done ?? -1) &&
    (a.tasks?.total ?? -1) === (b.tasks?.total ?? -1) &&
    a.planReady === b.planReady &&
    a.frozenElapsed === b.frozenElapsed
  );
}

function toTitleTab(
  tab: WorkspaceTab,
  sessions: Session[],
  dirtyFiles: Set<string>,
  planReady: Record<string, boolean>,
): TitleTab {
  const paneIds = leafIds(tab.layout);
  const multiPane = paneIds.length > 1;
  const tabSessions = paneIds
    .map((id) => sessions.find((session) => session.id === id))
    .filter((session): session is Session => session != null);
  const sessionFocused = tabSessions.some(
    (session) => session.id === tab.focusedId,
  );
  const fileFocused =
    !sessionFocused &&
    (tab.editorPanes.some((pane) => pane.id === tab.focusedId) ||
      (tab.terminalPanes ?? []).some((pane) => pane.id === tab.focusedId));
  const focused =
    sessions.find((session) => session.id === tab.focusedId) ?? tabSessions[0];

  const seen = new Set<HarnessId>();
  const harnesses: HarnessId[] = [];
  const busySeen = new Set<HarnessId>();
  const busyHarnesses: HarnessId[] = [];
  const ordered = focused
    ? [focused, ...tabSessions.filter((session) => session.id !== focused.id)]
    : tabSessions;
  for (const session of ordered) {
    if (
      session.busy &&
      !hasPendingApproval(session.blocks) &&
      !busySeen.has(session.harness)
    ) {
      busySeen.add(session.harness);
      busyHarnesses.push(session.harness);
    }
    if (seen.has(session.harness)) continue;
    seen.add(session.harness);
    harnesses.push(session.harness);
  }

  const files: string[] = [];
  const seenKeys = new Set<string>();
  const pushFile = (file: FilePaneTab) => {
    const key = file.terminal
      ? `terminal:${file.id}`
      : file.releaseNotes
        ? `release-notes:${file.releaseNotes.version}`
        : file.path;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    files.push(
      file.releaseNotes
        ? releaseNotesTitle(file.releaseNotes.version)
        : file.terminal
          ? terminalTabLabel(file)
          : basename(file.path),
    );
  };
  const focusedPane =
    tab.editorPanes.find((pane) => pane.id === tab.focusedId) ??
    (tab.terminalPanes ?? []).find((pane) => pane.id === tab.focusedId);
  const otherPanes = [
    ...tab.editorPanes.filter((pane) => pane.id !== focusedPane?.id),
    ...(tab.terminalPanes ?? []).filter((pane) => pane.id !== focusedPane?.id),
  ];
  const panes = focusedPane ? [focusedPane, ...otherPanes] : otherPanes;
  for (const pane of panes) {
    const active = pane.files.find((file) => file.id === pane.activeFileId);
    if (active) pushFile(active);
  }
  for (const pane of panes) {
    for (const file of pane.files) pushFile(file);
  }

  const more = tabSessions
    .filter((session) => session.id !== focused?.id)
    .map(conversationTitle)
    .filter(Boolean);

  const hasTerminal = (tab.terminalPanes ?? []).some((pane) =>
    pane.files.some(isTerminalTab),
  );
  const focusedFile = focusedFileTab(tab);

  return {
    thread: tabThreadOf(focused, planReady),
    updatedAt: focused ? sessionStore.metaOf(focused.id)?.updatedAt : undefined,
    id: tab.id,
    project: focused
      ? projectName(focused.cwd)
      : focusedFile
        ? projectName(focusedFile.cwd)
        : "~",
    title: focused ? conversationTitle(focused) : "",
    more,
    sessionCount: tabSessions.length,
    harnesses,
    busyHarnesses,
    files,
    multiPane,
    fileFocused,
    dirty: tab.editorPanes.some((pane) =>
      pane.files.some(
        (file) => isFilesystemTab(file) && dirtyFiles.has(file.id),
      ),
    ),
    terminal: hasTerminal && harnesses.length === 0,
    groupId: tab.groupId,
  };
}
