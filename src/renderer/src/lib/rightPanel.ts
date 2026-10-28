import { useSyncExternalStore } from "react";

/**
 * The right panel: one column at a thread's right edge whose sections
 * follow the thread's state (docs/LAYOUT.md "The right side"). One store
 * replaces the old rail flag, the rail tab, the notes drawer's map, the
 * orchestrator log's state and the fleet panel's open override. Open,
 * section and width are per thread id and persist across launches; a
 * thread opens on the section it last showed, a new thread on the width
 * the last panel was dragged to.
 */

export type Section = "activity" | "agents" | "changes" | "notes" | "files" | "build" | "debug";

export const SECTIONS: readonly Section[] = ["activity", "agents", "changes", "notes", "files", "build", "debug"];

export const SECTION_LABEL: Record<Section, string> = {
  activity: "Activity",
  agents: "Agents",
  changes: "Changes",
  notes: "Notes",
  files: "Files",
  build: "Build",
  debug: "Debug",
};

export const PANEL_WIDTH = 320;
export const PANEL_MIN = 260;
export const PANEL_MAX = 480;
/** The thread column never goes narrower than this beside its panel. */
export const THREAD_MIN = 360;

/**
 * The panel's drawn width in a row `containerWidth` wide: the stored width,
 * shrunk so the thread keeps `THREAD_MIN`, never under `PANEL_MIN`. Null
 * when even that does not fit: the panel is not drawn and keeps its stored
 * open state for when the row widens.
 */
export function panelFit(containerWidth: number, storedWidth: number): number | null {
  const room = Math.floor(containerWidth) - THREAD_MIN;
  if (room < PANEL_MIN) return null;
  return Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.min(storedWidth, room)));
}

/** The toggle's reason while a thread's row is too narrow for the panel. */
export const NO_ROOM_LABEL = "No room for the panel";

/** What the thread's state says about it; `sectionsFor` reads nothing else. */
export type PanelFacts = {
  /** A root thread (a subagent has no panel). */
  root: boolean;
  /** A thread of a project (it has a projectId) whose project has a checkout; never a loose chat, even in a project's folder. */
  project: boolean;
  /** A git checkout to show: the project's, or a loose chat's git workspace. */
  checkout: boolean;
  /** Subagents of the thread, live or settled. */
  agents: number;
  /** Subagents working or waiting. */
  liveAgents: number;
  /** Background shells and monitors the host reports. */
  backgroundTasks: number;
  /** A watching master waiting on its batch. */
  watching: boolean;
  /** A dev server of the project runs. */
  devRunning: boolean;
  /** A dev build, or the debug setting on: the Debug section is listed. */
  debug: boolean;
};

export type PanelSections = { sections: Section[]; defaultSection: Section | null };

/** The sections that exist for a thread in this state, in the header's order, and the one shown first. */
export function sectionsFor(facts: PanelFacts): PanelSections {
  if (!facts.root) return { sections: [], defaultSection: null };
  const activity = facts.backgroundTasks > 0 || facts.liveAgents > 0 || facts.watching || facts.devRunning;
  // One line per section, in the header's order; an area that retires a section deletes its line.
  const sections: Section[] = [];
  if (activity) sections.push("activity");
  // A master's batch lives on its board, never here: agents means its own subagents.
  if (facts.agents > 0) sections.push("agents");
  if (facts.checkout) sections.push("changes");
  sections.push("notes");
  if (facts.checkout) sections.push("files");
  if (facts.project) sections.push("build");
  if (facts.project && facts.debug) sections.push("debug");
  const defaultSection: Section = activity
    ? "activity"
    : facts.agents > 0
      ? "agents"
      : facts.checkout
        ? "changes"
        : "notes";
  return { sections, defaultSection };
}

/** The section the panel shows: the one asked for when it exists, else the default. */
export function shownSection(asked: Section | null, available: PanelSections): Section | null {
  if (asked && available.sections.includes(asked)) return asked;
  return available.defaultSection;
}

export type PanelState = { open: boolean; section: Section | null; width: number; /** "Debug this file" asked for the Debug section on this thread. */ debug: boolean };

const KEY = "monocode.rightPanel";
const MAX_THREADS = 200;

type Persisted = { width: number; threads: Record<string, { open: boolean; section: Section | null; width?: number; debug?: boolean }> };

function clampWidth(width: number): number {
  return Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(width)));
}

function load(): Persisted {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (raw && typeof raw === "object") {
      const { width, threads } = raw as Partial<Persisted>;
      return {
        width: typeof width === "number" ? clampWidth(width) : PANEL_WIDTH,
        threads: threads && typeof threads === "object" ? threads : {},
      };
    }
  } catch {
    /* no storage, or not JSON */
  }
  return { width: PANEL_WIDTH, threads: {} };
}

let data: Persisted = load();
const cache = new Map<string, PanelState>();
const listeners = new Set<() => void>();
let focusedId: string | null = null;
const visibleIds = new Set<string>();
/** Threads whose row is too narrow for the panel right now (never persisted). */
const noRoom = new Set<string>();

function save(): void {
  const ids = Object.keys(data.threads);
  if (ids.length > MAX_THREADS) {
    for (const id of ids.slice(0, ids.length - MAX_THREADS)) delete data.threads[id];
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* private mode */
  }
}

function emit(): void {
  for (const l of listeners) l();
}

/** A new focused thread is a change: the native menu reads which panel ⌘⇧R reaches. */
function setFocused(id: string | null): void {
  if (focusedId === id) return;
  focusedId = id;
  emit();
}

function stateOf(id: string): PanelState {
  const cached = cache.get(id);
  if (cached) return cached;
  const row = data.threads[id];
  const state: PanelState = {
    open: row?.open ?? false,
    section: row?.section ?? null,
    width: clampWidth(row?.width ?? data.width),
    debug: row?.debug ?? false,
  };
  cache.set(id, state);
  return state;
}

function write(id: string, patch: Partial<PanelState>): void {
  const prev = stateOf(id);
  const next: PanelState = { ...prev, ...patch };
  if (patch.width !== undefined) next.width = clampWidth(patch.width);
  if (next.open === prev.open && next.section === prev.section && next.width === prev.width && next.debug === prev.debug) return;
  cache.set(id, next);
  data.threads[id] = { open: next.open, section: next.section, width: next.width, ...(next.debug ? { debug: true } : {}) };
  if (patch.width !== undefined) data.width = next.width;
  save();
  emit();
}

export const rightPanel = {
  get: stateOf,
  set: write,
  open(id: string, section?: Section): void {
    write(id, { open: true, ...(section ? { section } : {}) });
  },
  close(id: string): void {
    write(id, { open: false });
  },
  /** Does nothing while the thread's row has no room for the panel. */
  toggle(id: string): void {
    if (noRoom.has(id)) return;
    write(id, { open: !stateOf(id).open });
  },
  /** ThreadView's measure: whether the thread's row fits the panel now. */
  setRoom(id: string, fits: boolean): void {
    if (fits === !noRoom.has(id)) return;
    if (fits) noRoom.delete(id);
    else noRoom.add(id);
    emit();
  },
  hasRoom(id: string): boolean {
    return !noRoom.has(id);
  },
  setWidth(id: string, width: number): void {
    write(id, { width });
  },
  /** The thread whose panel is on screen; `show` with no id reaches it. */
  focus(id: string | null): void {
    setFocused(id);
  },
  /** A thread's pane came on screen or left it. The target is the focused
   *  visible thread; when it leaves, another visible thread takes over, so
   *  an editor or the dock holding focus never leaves the shortcuts dead. */
  visible(id: string, on: boolean): void {
    if (on) {
      visibleIds.add(id);
      if (!focusedId) setFocused(id);
      return;
    }
    visibleIds.delete(id);
    if (focusedId === id) setFocused(visibleIds.values().next().value ?? null);
  },
  /** Open a section on the thread on screen (⌃D's Debug, the Dev Server button). */
  show(section: Section, id: string | null = focusedId): void {
    if (id) write(id, { open: true, section, ...(section === "debug" ? { debug: true } : {}) });
  },
  focused(): string | null {
    return focusedId;
  },
  /** Every change of a thread's panel and of the focused thread (the native menu's Show Panel). */
  subscribe(l: () => void): () => void {
    return subscribe(l);
  },
  /** Test seam. */
  reset(): void {
    data = { width: PANEL_WIDTH, threads: {} };
    cache.clear();
    focusedId = null;
    visibleIds.clear();
    noRoom.clear();
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* private mode */
    }
    emit();
  },
};

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Whether the thread's row has room for its panel (true until measured). */
export function usePanelRoom(id: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !noRoom.has(id),
    () => !noRoom.has(id),
  );
}

export function useRightPanel(id: string): PanelState {
  return useSyncExternalStore(
    subscribe,
    () => stateOf(id),
    () => stateOf(id),
  );
}
