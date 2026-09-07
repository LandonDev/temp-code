import { invoke, ask } from "./native";
import {
  hasInFlightSessions,
  inFlightRefs,
  quitWhileBusyMessage,
  type ResumedWorkspace,
} from "./inFlight";
import { leafIds, type WorkspaceTab } from "./layout";
import { killPty } from "./pty";
import {
  projectTerminalFileIds,
  type ProjectTerminalDock,
} from "./projectTerminal";
import type { Session } from "./session";
import { restoreSessionCheckout } from "./fs";
import {
  getSession,
  peekSession,
  listSessionsByProject,
  loadWorkspaceSnapshot,
  saveWorkspaceSnapshot,
  type SessionSummary,
} from "./sessionStore";
import {
  collectWorkspaceSnapshot,
  hydrateWorkspaceSnapshot,
  parseWorkspaceSnapshot,
} from "./workspaceSnapshot";
import { loadWindowTransfer } from "./windowTransferBootstrap";
import type { WindowTransferPayload } from "./windowTransfer";
import { lastProjectPath, normalizeProjectPath, sameProjectPath } from "./recents";

export type { ResumedWorkspace };
export { hasInFlightSessions };

/**
 * Boot and quit. Transcripts live on the server; the app keeps only the
 * workspace snapshot (tabs, panes, which session sits where). Boot loads
 * the snapshot, asks the server for each session it names, and drops
 * nothing else: a session the server no longer lists opens as a blank
 * draft in its old pane.
 */

export type BootWorkspace = {
  windowTransfer: WindowTransferPayload | null;
  resumed: ResumedWorkspace | null;
  /** Sidebar rows listed before first paint, so the rail is not empty. */
  history: SessionSummary[];
  historyCwd: string | null;
};

let resumedPromise: Promise<ResumedWorkspace | null> | null = null;
let bootPromise: Promise<BootWorkspace> | null = null;
let quitting = false;
let quitDialogOpen = false;
let bootingResumed: ResumedWorkspace | null = null;
let liveWorkspace: {
  sessions: () => Session[];
  tabs: () => WorkspaceTab[];
  activeTabId: () => string;
  projectCwd: () => string;
  projectTerminals: () => ProjectTerminalDock[];
} | null = null;

export function isAppQuitting(): boolean {
  return quitting;
}

export function setQuitWorkspace(
  sessions: () => Session[],
  tabs: () => WorkspaceTab[],
  activeTabId: () => string,
  projectCwd: () => string,
  projectTerminals: () => ProjectTerminalDock[],
): () => void {
  liveWorkspace = { sessions, tabs, activeTabId, projectCwd, projectTerminals };
  bootingResumed = null;
  return () => {
    if (liveWorkspace?.sessions === sessions) liveWorkspace = null;
  };
}

export async function handleQuitRequested(): Promise<void> {
  if (liveWorkspace) {
    await confirmQuitAndExit(
      liveWorkspace.sessions(),
      liveWorkspace.tabs(),
      liveWorkspace.activeTabId(),
      liveWorkspace.projectCwd(),
      liveWorkspace.projectTerminals(),
    );
    return;
  }
  const { resumed } = await loadBootWorkspace();
  const pending = resumed ?? bootingResumed;
  if (pending) {
    quitting = true;
    try {
      await persistBootingResume(pending);
      await invoke("confirm_quit");
    } catch {
      quitting = false;
    }
    return;
  }
  await invoke("confirm_quit");
}

export function loadResumedWorkspace(): Promise<ResumedWorkspace | null> {
  if (!resumedPromise) resumedPromise = loadResumedWorkspaceOnce();
  return resumedPromise;
}

/** Transfer and restore run once; callers share the same promise. */
export function loadBootWorkspace(): Promise<BootWorkspace> {
  if (!bootPromise) {
    bootPromise = (async () => {
      const hintedCwd = lastProjectPath();
      const historyHint = listProjectHistory(hintedCwd);
      const windowTransfer = await loadWindowTransfer();
      if (windowTransfer) {
        // The payload names the sessions; their transcripts come from the server.
        const sessions = await Promise.all(
          windowTransfer.sessions.map(
            async (session) => (await getSession(session.id).catch(() => null)) ?? session,
          ),
        );
        const listed = await historyForCwd(
          windowTransfer.projectCwd,
          hintedCwd,
          historyHint,
        );
        return {
          windowTransfer: { ...windowTransfer, sessions },
          resumed: null,
          history: listed?.rows ?? [],
          historyCwd: listed?.cwd ?? null,
        };
      }
      const [resumed, hinted] = await Promise.all([
        loadResumedWorkspace(),
        historyHint,
      ]);
      const listed = await historyForCwd(
        resumed?.projectCwd ?? hintedCwd,
        hintedCwd,
        Promise.resolve(hinted),
      );
      return {
        windowTransfer: null,
        resumed,
        history: listed?.rows ?? [],
        historyCwd: listed?.cwd ?? null,
      };
    })();
  }
  return bootPromise;
}

async function listProjectHistory(
  cwd: string | null | undefined,
): Promise<{ cwd: string; rows: SessionSummary[] } | null> {
  if (!cwd || cwd === "~") return null;
  try {
    const rows = await listSessionsByProject(cwd);
    return { cwd: normalizeProjectPath(cwd), rows };
  } catch {
    return null;
  }
}

async function historyForCwd(
  cwd: string | null | undefined,
  hintedCwd: string | null | undefined,
  hinted: Promise<{ cwd: string; rows: SessionSummary[] } | null>,
): Promise<{ cwd: string; rows: SessionSummary[] } | null> {
  if (!cwd || cwd === "~") return null;
  if (hintedCwd && sameProjectPath(cwd, hintedCwd)) return hinted;
  return listProjectHistory(cwd);
}

async function loadResumedWorkspaceOnce(): Promise<ResumedWorkspace | null> {
  const snapshotRaw = await loadWorkspaceSnapshot().catch(() => null);
  const snapshot = parseWorkspaceSnapshot(snapshotRaw);
  if (!snapshot) return null;

  const ids = new Set<string>();
  for (const stub of snapshot.sessions) ids.add(stub.id);
  for (const tab of snapshot.tabs) {
    for (const id of leafIds(tab.layout)) ids.add(id);
  }
  // Only the tab on screen needs its transcript before first paint. The
  // other tabs restore from the server's meta (no blocks) and fetch their
  // history when their pane mounts, one per idle slice after paint, so
  // launch does not scale with how many heavy tabs the workspace holds.
  const activeTab =
    snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId) ?? snapshot.tabs[0];
  const activeIds = new Set(activeTab ? leafIds(activeTab.layout) : []);

  const loaded = new Map<string, Session>();
  await Promise.all(
    [...ids].map(async (id) => {
      const record = await (activeIds.has(id) ? getSession(id) : peekSession(id)).catch(
        () => null,
      );
      if (record) loaded.set(id, record);
    }),
  );

  let workspace = hydrateWorkspaceSnapshot(snapshot, loaded);
  if (workspace) {
    workspace = {
      ...workspace,
      sessions: await Promise.all(
        workspace.sessions.map((session) => restoreSessionCheckout(session)),
      ),
    };
  }
  bootingResumed = workspace;
  return workspace;
}

export async function hideCurrentWindow(): Promise<void> {
  await invoke("hide_window");
}

export async function closeCurrentWindow(): Promise<void> {
  await invoke("destroy_window");
}

/** Quit and unload keep only the layout; the server keeps the chats. */
export async function persistQuitState(
  sessions: Session[],
  tabs: WorkspaceTab[],
  activeTabId: string,
  projectCwd: string,
  projectTerminals: ProjectTerminalDock[] = [],
): Promise<void> {
  await saveWorkspaceSnapshot(
    collectWorkspaceSnapshot(
      tabs,
      sessions,
      activeTabId,
      projectCwd,
      projectTerminals,
    ),
  ).catch(() => undefined);
}

async function persistBootingResume(workspace: ResumedWorkspace): Promise<void> {
  await persistQuitState(
    workspace.sessions,
    workspace.tabs,
    workspace.activeTabId,
    workspace.projectCwd,
    workspace.projectTerminals ?? [],
  );
}

async function confirmQuitAndExit(
  sessions: Session[],
  tabs: WorkspaceTab[],
  activeTabId: string,
  projectCwd: string,
  projectTerminals: ProjectTerminalDock[] = [],
): Promise<void> {
  if (quitDialogOpen) return;
  quitDialogOpen = true;
  try {
    const refs = inFlightRefs(sessions, tabs);
    if (refs.length > 0) {
      const ok = await ask(quitWhileBusyMessage(refs.length), {
        title: "MonoCode",
        kind: "warning",
        okLabel: "Quit",
      });
      if (!ok) return;
    }
    quitting = true;
    try {
      await persistQuitState(sessions, tabs, activeTabId, projectCwd, projectTerminals);
      await invoke("confirm_quit");
    } catch {
      quitting = false;
    }
  } finally {
    quitDialogOpen = false;
  }
}

/** Terminals are the only child processes this window still owns. */
export async function reapWindowRuntime(
  tabs: WorkspaceTab[],
  projectTerminals: ProjectTerminalDock[] = [],
): Promise<void> {
  await Promise.all(
    [...terminalFileIds(tabs), ...projectTerminalFileIds(projectTerminals)].map(
      (id) => killPty(id),
    ),
  );
}

function terminalFileIds(tabs: WorkspaceTab[]): string[] {
  const ids: string[] = [];
  for (const tab of tabs) {
    for (const pane of [...tab.editorPanes, ...(tab.terminalPanes ?? [])]) {
      for (const file of pane.files) {
        if (file.terminal) ids.push(file.id);
      }
    }
  }
  return ids;
}
