import { closeLeaf, leaf, leafIds, type WorkspaceTab } from "./layout";
import type { Session } from "./session";
import { archiveNeighbour, type HeaderModel } from "./threadHeaderModel";
import { planWorkspaceTabClose } from "./workspaceTabGroups";

/**
 * What a thread's Delete leaves on screen. The window stays on the
 * project, always: the host's `session-removed` push lands before the
 * delete's answer (and a draft leaves the store at once), so everything is
 * decided from the layout and the sessions as they stood before the delete,
 * where the deleted thread's project is still known.
 *
 * - The thread on screen, alone in its tab: its neighbour chip takes its
 *   place, as Archive does (`select`). A neighbour with a tab of its own
 *   brings that tab forward and the deleted tab closes; one without takes
 *   the deleted tab's place. With no neighbour, another tab of the project
 *   comes forward, else the tab becomes the project's empty new-thread
 *   screen (`createReplacement`).
 * - The thread on screen in a split: its pane closes; the split's other
 *   panes stay.
 * - A thread not on screen: its pane or tab goes; nothing else moves.
 */
export type ThreadDeleteInput = {
  tabs: WorkspaceTab[];
  /** The open sessions before the delete. */
  sessions: Session[];
  activeTabId: string;
  sessionId: string;
  /** The deleted thread's project: its own, else the window's. */
  projectKey: string | null;
  /** The strip's neighbour chip, when the deleted thread is on screen. */
  neighbourId: string | null;
  createReplacement: (seed: Session | undefined) => Session;
};

export type ThreadDeletePlan = {
  tabs: WorkspaceTab[];
  sessions: Session[];
  activeTabId: string;
  /** A thread to open as a click on its chip would. */
  select: string | null;
};

export function planThreadDelete(input: ThreadDeleteInput): ThreadDeletePlan {
  const { tabs, sessions, activeTabId, sessionId, neighbourId } = input;
  let nextTabs = [...tabs];
  let nextSessions = sessions.filter((session) => session.id !== sessionId);
  let nextActive = activeTabId;
  let select: string | null = null;

  for (const tab of tabs) {
    if (!leafIds(tab.layout).includes(sessionId)) continue;
    const at = nextTabs.findIndex((entry) => entry.id === tab.id);
    if (at < 0) continue;
    const closed = closeLeaf(tab, sessionId);
    if (closed) {
      nextTabs[at] = closed;
      continue;
    }
    if (tab.id !== activeTabId) {
      nextTabs = nextTabs.filter((entry) => entry.id !== tab.id);
      continue;
    }
    const neighbourTab = neighbourId
      ? nextTabs.find((entry) => entry.id !== tab.id && leafIds(entry.layout).includes(neighbourId))
      : undefined;
    if (neighbourTab) {
      nextTabs = nextTabs.filter((entry) => entry.id !== tab.id);
      nextActive = neighbourTab.id;
      select = neighbourId;
      continue;
    }
    if (!neighbourId) {
      const close = planWorkspaceTabClose({
        tabs: nextTabs,
        sessions,
        closingTabId: tab.id,
        scope: "project",
        fallbackKey: input.projectKey,
      });
      if (close.action === "close" && close.nextActiveTabId) {
        nextTabs = nextTabs.filter((entry) => entry.id !== tab.id);
        nextActive = close.nextActiveTabId;
        continue;
      }
    }
    // The project's empty screen, which a neighbour then takes as a click
    // on its chip fills a blank pane.
    const replacement = input.createReplacement(sessions.find((session) => session.id === sessionId));
    nextSessions = [...nextSessions, replacement];
    nextTabs[at] = { ...tab, layout: leaf(replacement.id), focusedId: replacement.id, editorPanes: [], terminalPanes: [] };
    select = neighbourId;
  }

  return { tabs: nextTabs, sessions: nextSessions, activeTabId: nextActive, select };
}

/** The chip that takes a deleted thread's place: Archive's neighbour on the
 *  project's strip, never the chip of a thread from another scope that only
 *  sits there because it is on screen. */
export function deleteNeighbour(model: HeaderModel, sessionId: string): string | null {
  const outside = model.outsideId;
  const scoped = outside && outside !== sessionId ? { ...model, live: model.live.filter((chip) => chip.id !== outside) } : model;
  return archiveNeighbour(scoped, sessionId)?.id ?? null;
}
