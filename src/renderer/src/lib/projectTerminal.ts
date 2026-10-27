import {
  newEditorPane,
  nextTerminalTitleFromFiles,
  type EditorPane,
  type FilePaneTab,
  type WorkspaceTab,
} from "./layout";
import {
  normalizeProjectPath,
  sameProjectPath,
} from "./recents";
import type { Session } from "./session";
import {
  applyTerminalMeta,
  type TerminalMetaPatch,
} from "./terminalTab";
import { workspaceTabCwd } from "./workspaceTabGroups";

export type ProjectTerminalDock = {
  projectPath: string;
  pane: EditorPane;
  /** The dock's height in px: it is bottom only. */
  size: number;
  open: boolean;
};

export const DOCK_SIZE_DEFAULT = 220;

const DOCK_SIZE_MIN = 88;

/** A height between the minimum and 70% of the viewport's. */
export function clampDockSize(
  value: number,
  viewport: { width: number; height: number } = {
    width: 1280,
    height: 800,
  },
): number {
  const max = Math.max(DOCK_SIZE_MIN, Math.floor(viewport.height * 0.7));
  if (!Number.isFinite(value)) return DOCK_SIZE_DEFAULT;
  return Math.min(max, Math.max(DOCK_SIZE_MIN, Math.round(value)));
}

export function findProjectTerminal(
  docks: ProjectTerminalDock[],
  projectPath: string,
): ProjectTerminalDock | undefined {
  return docks.find((dock) => sameProjectPath(dock.projectPath, projectPath));
}

export function createProjectTerminal(
  projectPath: string,
  file: FilePaneTab,
): ProjectTerminalDock {
  return {
    projectPath: normalizeProjectPath(projectPath),
    pane: newEditorPane(file),
    size: DOCK_SIZE_DEFAULT,
    open: true,
  };
}

export function addTerminalToDock(
  dock: ProjectTerminalDock,
  file: FilePaneTab,
): ProjectTerminalDock {
  return {
    ...dock,
    open: true,
    pane: {
      ...dock.pane,
      files: [...dock.pane.files, file],
      activeFileId: file.id,
    },
  };
}

/** A terminal joins without taking over: the dock opens, and a tab an open dock already shows stays selected. */
export function addTerminalQuietly(
  dock: ProjectTerminalDock,
  file: FilePaneTab,
): ProjectTerminalDock {
  const shown = dock.open && dock.pane.files.some((f) => f.id === dock.pane.activeFileId);
  return {
    ...dock,
    open: true,
    pane: {
      ...dock.pane,
      files: [...dock.pane.files, file],
      activeFileId: shown ? dock.pane.activeFileId : file.id,
    },
  };
}

export function nextDockTerminalTitle(
  dock: ProjectTerminalDock,
  cwd: string,
): string {
  return nextTerminalTitleFromFiles(dock.pane.files, cwd);
}

export function closeTerminalInDock(
  dock: ProjectTerminalDock,
  fileId: string,
): ProjectTerminalDock | null {
  const index = dock.pane.files.findIndex((file) => file.id === fileId);
  if (index < 0) return dock;
  const files = dock.pane.files.filter((file) => file.id !== fileId);
  if (files.length === 0) return null;
  const activeFileId =
    dock.pane.activeFileId === fileId
      ? files[Math.min(index, files.length - 1)].id
      : dock.pane.activeFileId;
  return { ...dock, pane: { ...dock.pane, files, activeFileId } };
}

export function selectDockTerminal(
  dock: ProjectTerminalDock,
  fileId: string,
): ProjectTerminalDock {
  if (
    !dock.pane.files.some((file) => file.id === fileId) ||
    dock.pane.activeFileId === fileId
  ) {
    return dock;
  }
  return { ...dock, pane: { ...dock.pane, activeFileId: fileId } };
}

export function reorderDockTerminals(
  dock: ProjectTerminalDock,
  files: FilePaneTab[],
): ProjectTerminalDock {
  return { ...dock, pane: { ...dock.pane, files } };
}

export function patchDockTerminal(
  dock: ProjectTerminalDock,
  fileId: string,
  patch: TerminalMetaPatch,
): ProjectTerminalDock {
  let changed = false;
  const files = dock.pane.files.map((file) => {
    if (!file.terminal || file.id !== fileId) return file;
    const next = applyTerminalMeta(file, patch);
    if (next !== file) changed = true;
    return next;
  });
  if (!changed) return dock;
  return { ...dock, pane: { ...dock.pane, files } };
}

export function patchProjectTerminals(
  docks: ProjectTerminalDock[],
  fileId: string,
  patch: TerminalMetaPatch,
): ProjectTerminalDock[] {
  let changed = false;
  const next = docks.map((dock) => {
    const updated = patchDockTerminal(dock, fileId, patch);
    if (updated !== dock) changed = true;
    return updated;
  });
  return changed ? next : docks;
}

export function mapProjectTerminal(
  docks: ProjectTerminalDock[],
  projectPath: string,
  update: (dock: ProjectTerminalDock) => ProjectTerminalDock | null,
): ProjectTerminalDock[] {
  let found = false;
  const next: ProjectTerminalDock[] = [];
  for (const dock of docks) {
    if (!sameProjectPath(dock.projectPath, projectPath)) {
      next.push(dock);
      continue;
    }
    found = true;
    const updated = update(dock);
    if (updated) next.push(updated);
  }
  return found ? next : docks;
}

export function withDockOpen(
  dock: ProjectTerminalDock,
  open: boolean,
): ProjectTerminalDock {
  return dock.open === open ? dock : { ...dock, open };
}

export function withDockSize(
  dock: ProjectTerminalDock,
  size: number,
  viewport?: { width: number; height: number },
): ProjectTerminalDock {
  const next = clampDockSize(size, viewport);
  return next === dock.size ? dock : { ...dock, size: next };
}

export function projectTerminalFileIds(
  docks: ProjectTerminalDock[],
): string[] {
  const ids: string[] = [];
  for (const dock of docks) {
    for (const file of dock.pane.files) {
      if (file.terminal) ids.push(file.id);
    }
  }
  return ids;
}

/** The dock grid: the main area alone, or over a dock `size` px tall. */
export function applyDockGridStyle(el: HTMLElement, size: number | null): void {
  el.style.gridTemplateRows = size == null ? "minmax(0, 1fr)" : `minmax(0, 1fr) ${Math.max(1, Math.round(size))}px`;
  el.style.gridTemplateColumns = "minmax(0, 1fr)";
  el.style.gridTemplateAreas = size == null ? '"main"' : '"main" "dock"';
}

/**
 * A dock follows the tabs of its project into a new window only when
 * every remaining tab of that project is leaving too — otherwise the
 * original window keeps the running terminals.
 */
export function splitProjectTerminalsForMove(
  docks: ProjectTerminalDock[],
  movingTabs: WorkspaceTab[],
  remainingTabs: WorkspaceTab[],
  sessions: Session[],
): { moving: ProjectTerminalDock[]; remaining: ProjectTerminalDock[] } {
  const remainingProjects = projectPathsOf(remainingTabs, sessions);
  const movingProjects = projectPathsOf(movingTabs, sessions);
  const moving: ProjectTerminalDock[] = [];
  const remaining: ProjectTerminalDock[] = [];
  for (const dock of docks) {
    const path = normalizeProjectPath(dock.projectPath);
    const stays = remainingProjects.has(path);
    const follows = movingProjects.has(path) && !stays;
    if (follows) moving.push(dock);
    else remaining.push(dock);
  }
  return { moving, remaining };
}

function projectPathsOf(
  tabs: WorkspaceTab[],
  sessions: Session[],
): Set<string> {
  const paths = new Set<string>();
  for (const tab of tabs) {
    const cwd = workspaceTabCwd(tab, sessions);
    if (cwd) paths.add(normalizeProjectPath(cwd));
  }
  return paths;
}
