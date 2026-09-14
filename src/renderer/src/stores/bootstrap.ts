import { historyStore } from "../lib/historyStore";
import type { ResumedWorkspace } from "../lib/inFlight";
import { newTab, type WorkspaceTab } from "../lib/layout";
import type { ProjectTerminalDock } from "../lib/projectTerminal";
import {
  lastProjectPath,
  loadRecents,
  looksLikeProject,
  normalizeProjectPath,
  rememberProject,
  type RecentProject,
} from "../lib/recents";
import { newDefaultSession, type Session } from "../lib/session";
import type { SessionSummary } from "../lib/sessionStore";
import { sessionStore } from "../lib/tcserver/store";
import type { InstalledUpdate } from "../lib/updateNotice";
import type { WindowTransferPayload } from "../lib/windowTransfer";
import { loadSelectedProject } from "../lib/projectContext";
import { projectStore } from "./project";
import { shell } from "./shell";
import { initialWorkspaceTabsState, workspaceTabsStore } from "./workspace";

/** What the boot loader found: a window transfer, a resumed workspace, or neither. */
export type BootInput = {
  windowTransfer: WindowTransferPayload | null;
  resumed: ResumedWorkspace | null;
  history: SessionSummary[];
  historyCwd: string | null;
  installedUpdate: InstalledUpdate | null;
};

/** The first render's workspace, decided once before React mounts. */
export type BootWorkspace = {
  projectCwd: string;
  recents: RecentProject[];
  tabs: WorkspaceTab[];
  projectTerminals: ProjectTerminalDock[];
  activeTabId: string;
  /** The composer takes focus when the active tab is a chat we know. */
  composerFocused: boolean;
  dirtyFileIds: string[];
  /** Projects whose history rows the loader already brought. */
  loadedProjects: ReadonlySet<string>;
};

/** A blank chat in the last project, for a window with nothing to restore. */
export type BootSeed = { session: Session; tab: WorkspaceTab };

export function newBootSeed(cwd: string = lastProjectPath() ?? "~"): BootSeed {
  const session = newDefaultSession(cwd);
  return { session, tab: newTab(session.id) };
}

/**
 * A transfer outranks a resume, which outranks the seed. Pure: the sessions
 * to seed the store with come back alongside the workspace so the caller
 * decides whether the store still needs them.
 */
export function planBoot(
  input: Omit<BootInput, "installedUpdate">,
  seed: BootSeed,
  recents: RecentProject[] = loadRecents(),
): BootWorkspace & { sessions: Session[] } {
  const { windowTransfer, resumed, historyCwd } = input;
  const activeTabId =
    windowTransfer?.activeTabId ?? resumed?.activeTabId ?? seed.tab.id;
  const composerFocused = windowTransfer
    ? true
    : resumed
      ? resumedComposerFocused(resumed)
      : false;
  return {
    projectCwd:
      windowTransfer?.projectCwd ?? resumed?.projectCwd ?? seed.session.cwd,
    recents,
    sessions: windowTransfer?.sessions ?? resumed?.sessions ?? [seed.session],
    tabs: windowTransfer?.tabs ?? resumed?.tabs ?? [seed.tab],
    projectTerminals:
      windowTransfer?.projectTerminals ?? resumed?.projectTerminals ?? [],
    activeTabId,
    composerFocused,
    dirtyFileIds: windowTransfer?.dirtyFileIds ?? [],
    loadedProjects: historyCwd
      ? new Set([normalizeProjectPath(historyCwd)])
      : new Set(),
  };
}

function resumedComposerFocused(resumed: ResumedWorkspace): boolean {
  const tab =
    resumed.tabs.find((entry) => entry.id === resumed.activeTabId) ??
    resumed.tabs[0];
  return (
    !!tab && resumed.sessions.some((session) => session.id === tab.focusedId)
  );
}

/**
 * Called from `main.tsx` before the first render: fills the session and
 * history stores when they are still empty, notes the installed update, and
 * returns the workspace App mounts with. Session and history stores that
 * already hold state (a second mount in the same page) keep it; the project
 * and workspace stores take the boot's placement either way.
 */
export function bootstrapWorkspace(input: BootInput): BootWorkspace {
  const seed = newBootSeed();
  const recents =
    input.resumed?.projectCwd && looksLikeProject(input.resumed.projectCwd)
      ? rememberProject(input.resumed.projectCwd)
      : loadRecents();
  const { sessions, ...workspace } = planBoot(input, seed, recents);
  if (sessionStore.getSnapshot().length === 0) sessionStore.mutate(sessions);
  if (historyStore.get().length === 0 && input.history.length > 0) {
    historyStore.set(input.history);
  }
  shell.setUpdateNotice(input.installedUpdate);
  projectStore.setState({
    projectCwd: workspace.projectCwd,
    recents: workspace.recents,
    selectedProjectId: loadSelectedProject(workspace.projectCwd),
    loadedProjects: workspace.loadedProjects,
  });
  workspaceTabsStore.setState(
    initialWorkspaceTabsState(workspace.tabs, workspace.activeTabId),
    true,
  );
  return workspace;
}
