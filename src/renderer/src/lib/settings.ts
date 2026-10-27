import { requestSettings } from "./monaco/debugTab";
import { ALT, IS_MAC, MOD, SHIFT } from "./platform";

const SECTION_KEY = "monocode.settingsSection";

export type StaticSettingsSectionId =
  | "general"
  | "appearance"
  | "editor"
  | "keybindings"
  | "remote"
  | "defaults"
  | "providers"
  | "orchestration"
  | "reviews"
  | "build"
  | "appshots"
  | "archive";

/** A fixed page, or one workspace's own page (`ws:<workspace id>`). */
export type SettingsSectionId = StaticSettingsSectionId | `ws:${string}`;

/** The nav's groups, in order; the workspaces follow them. */
export const SETTINGS_GROUPS = [
  { id: "app", label: "App" },
  { id: "threads", label: "Threads" },
] as const;

export type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]["id"];

export const SETTINGS_SECTIONS: {
  id: StaticSettingsSectionId;
  group: SettingsGroupId;
  label: string;
  description: string;
}[] = [
  { id: "general", group: "app", label: "General", description: "How the app behaves, and the release you run." },
  { id: "appearance", group: "app", label: "Appearance", description: "Theme and the editor's type size." },
  { id: "editor", group: "app", label: "Editor", description: "Saving, completions and the language servers." },
  { id: "keybindings", group: "app", label: "Keybindings", description: "Every shortcut the app handles." },
  { id: "remote", group: "app", label: "Hosts", description: "This machine and every host it is paired with." },
  {
    id: "defaults",
    group: "threads",
    label: "Thread defaults",
    description: "What a new thread starts with. A workspace can override it.",
  },
  { id: "providers", group: "threads", label: "Providers", description: "The agent CLIs this machine can run." },
  {
    id: "orchestration",
    group: "threads",
    label: "Orchestration",
    description:
      "What threads that spawn subagents may do themselves, which models they may spawn, and where each kind of work goes.",
  },
  {
    id: "reviews",
    group: "threads",
    label: "Reviews",
    description:
      "A second model reads an implementation thread's branch before it lands on the project branch. Projects can override this from their settings.",
  },
  {
    id: "build",
    group: "threads",
    label: "Build",
    description:
      "The command the Build rail tab runs for a workspace, and the files it produces. Projects can override it in their settings.",
  },
  {
    id: "appshots",
    group: "threads",
    label: "Appshots",
    description:
      "Double-tap ⌘ over another app to drop its window, image and text, into a chat.",
  },
  {
    id: "archive",
    group: "threads",
    label: "Archive",
    description:
      "Archived projects and threads from every project. Restore one to keep working in it.",
  },
];

export const SETTINGS_SECTION_DEFAULT: SettingsSectionId = "general";

/** The page a stored id names now: Environments became part of Hosts. */
export function normalizeSettingsSection(value: unknown): unknown {
  return value === "environments" ? "remote" : value;
}

export function isSettingsSectionId(
  value: unknown,
): value is SettingsSectionId {
  return (
    SETTINGS_SECTIONS.some((section) => section.id === value) ||
    (typeof value === "string" && value.startsWith("ws:") && value.length > 3)
  );
}

export const workspaceSettingsSection = (workspaceId: string): SettingsSectionId =>
  `ws:${workspaceId}`;

/** The workspace a section belongs to, or null for the fixed pages. */
export function workspaceOfSection(id: SettingsSectionId): string | null {
  return id.startsWith("ws:") ? id.slice(3) : null;
}

/** Open Settings on one workspace's page (defaults, turn pass, build, rules). */
export function openWorkspaceSettings(workspaceId: string): void {
  requestSettings(workspaceSettingsSection(workspaceId));
}

export function settingsSectionLabel(id: SettingsSectionId): string {
  if (workspaceOfSection(id)) return "Workspace";
  return (
    SETTINGS_SECTIONS.find((section) => section.id === id)?.label ?? "General"
  );
}

export function settingsSectionDescription(id: SettingsSectionId): string {
  return (
    SETTINGS_SECTIONS.find((section) => section.id === id)?.description ?? ""
  );
}

export function loadSettingsSection(): SettingsSectionId {
  try {
    const raw = normalizeSettingsSection(localStorage.getItem(SECTION_KEY));
    return isSettingsSectionId(raw) ? raw : SETTINGS_SECTION_DEFAULT;
  } catch {
    return SETTINGS_SECTION_DEFAULT;
  }
}

export function saveSettingsSection(id: SettingsSectionId) {
  try {
    localStorage.setItem(SECTION_KEY, id);
  } catch {
    // private mode / quota
  }
}

const COMPOSER_RUNNER_KEY = "monocode.composerRunner";

export const COMPOSER_RUNNER_DEFAULT = true;

/** Fired on `window` when the composer mascot setting flips. */
export const COMPOSER_RUNNER_CHANGE_EVENT = "monocode:composer-runner-change";

export function loadComposerRunner(): boolean {
  try {
    const raw = localStorage.getItem(COMPOSER_RUNNER_KEY);
    if (raw == null) return COMPOSER_RUNNER_DEFAULT;
    return raw === "1" || raw === "true";
  } catch {
    return COMPOSER_RUNNER_DEFAULT;
  }
}

export function saveComposerRunner(value: boolean) {
  try {
    localStorage.setItem(COMPOSER_RUNNER_KEY, value ? "1" : "0");
  } catch {
    // private mode / quota
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<boolean>(COMPOSER_RUNNER_CHANGE_EVENT, { detail: value }),
  );
}

const NOTES_ENABLED_KEY = "monocode.notesEnabled";

export const NOTES_ENABLED_DEFAULT = true;

/** Fired on `window` when the Notes UI setting flips. */
export const NOTES_ENABLED_CHANGE_EVENT = "monocode:notes-enabled-change";

export function loadNotesEnabled(): boolean {
  try {
    const raw = localStorage.getItem(NOTES_ENABLED_KEY);
    if (raw == null) return NOTES_ENABLED_DEFAULT;
    return raw === "1" || raw === "true";
  } catch {
    return NOTES_ENABLED_DEFAULT;
  }
}

export function saveNotesEnabled(value: boolean) {
  try {
    localStorage.setItem(NOTES_ENABLED_KEY, value ? "1" : "0");
  } catch {
    // private mode / quota
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<boolean>(NOTES_ENABLED_CHANGE_EVENT, { detail: value }),
  );
}

export function subscribeNotesEnabled(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(NOTES_ENABLED_CHANGE_EVENT, onStoreChange);
  return () =>
    window.removeEventListener(NOTES_ENABLED_CHANGE_EVENT, onStoreChange);
}

const LIVE_AGENTS_ENABLED_KEY = "monocode.liveAgentsEnabled";

export const LIVE_AGENTS_ENABLED_DEFAULT = true;

/** Fired on `window` when the working-agents rail card setting flips. */
export const LIVE_AGENTS_ENABLED_CHANGE_EVENT =
  "monocode:live-agents-enabled-change";

export function loadLiveAgentsEnabled(): boolean {
  try {
    const raw = localStorage.getItem(LIVE_AGENTS_ENABLED_KEY);
    if (raw == null) return LIVE_AGENTS_ENABLED_DEFAULT;
    return raw === "1" || raw === "true";
  } catch {
    return LIVE_AGENTS_ENABLED_DEFAULT;
  }
}

export function saveLiveAgentsEnabled(value: boolean) {
  try {
    localStorage.setItem(LIVE_AGENTS_ENABLED_KEY, value ? "1" : "0");
  } catch {
    // private mode / quota
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<boolean>(LIVE_AGENTS_ENABLED_CHANGE_EVENT, {
      detail: value,
    }),
  );
}

export function subscribeLiveAgentsEnabled(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(LIVE_AGENTS_ENABLED_CHANGE_EVENT, onStoreChange);
  return () =>
    window.removeEventListener(LIVE_AGENTS_ENABLED_CHANGE_EVENT, onStoreChange);
}

const GRID_ARCADE_ENABLED_KEY = "monocode.gridArcadeEnabled";

export const GRID_ARCADE_ENABLED_DEFAULT = true;

/** Fired on `window` when the empty-session games setting flips. */
export const GRID_ARCADE_ENABLED_CHANGE_EVENT =
  "monocode:grid-arcade-enabled-change";

export function loadGridArcadeEnabled(): boolean {
  try {
    const raw = localStorage.getItem(GRID_ARCADE_ENABLED_KEY);
    if (raw == null) return GRID_ARCADE_ENABLED_DEFAULT;
    return raw === "1" || raw === "true";
  } catch {
    return GRID_ARCADE_ENABLED_DEFAULT;
  }
}

export function saveGridArcadeEnabled(value: boolean) {
  try {
    localStorage.setItem(GRID_ARCADE_ENABLED_KEY, value ? "1" : "0");
  } catch {
    // private mode / quota
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<boolean>(GRID_ARCADE_ENABLED_CHANGE_EVENT, {
      detail: value,
    }),
  );
}

export function subscribeGridArcadeEnabled(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(GRID_ARCADE_ENABLED_CHANGE_EVENT, onStoreChange);
  return () =>
    window.removeEventListener(GRID_ARCADE_ENABLED_CHANGE_EVENT, onStoreChange);
}

const CLAUDE_HOOKS_KEY = "monocode.claudeHooks";

export const CLAUDE_HOOKS_DEFAULT = true;

export function loadClaudeHooks(): boolean {
  try {
    const raw = localStorage.getItem(CLAUDE_HOOKS_KEY);
    if (raw == null) return CLAUDE_HOOKS_DEFAULT;
    return raw === "1" || raw === "true";
  } catch {
    return CLAUDE_HOOKS_DEFAULT;
  }
}

export function saveClaudeHooks(value: boolean) {
  try {
    localStorage.setItem(CLAUDE_HOOKS_KEY, value ? "1" : "0");
  } catch {
    // private mode / quota
  }
}

const CTRL = IS_MAC ? "⌃" : "Ctrl+";

export type KeybindingRow = {
  command: string;
  keys: string;
  when: string;
};

/**
 * Mirrors the bindings we actually handle: the command map in
 * lib/appCommands.ts (native menu accelerators, `tabCommand`, window keys).
 */
export const KEYBINDINGS: KeybindingRow[] = [
  { command: "App: Search", keys: `${MOD}K`, when: "Always" },
  { command: "App: Go to File", keys: `${MOD}P`, when: "Always" },
  { command: "App: Go to File", keys: "Shift Shift", when: "Always" },
  { command: "App: Go to Symbol", keys: `${MOD}O`, when: "Always" },
  { command: "App: Type Hierarchy", keys: `${MOD}T`, when: "Always" },
  { command: "App: Find in Files", keys: `${MOD}${SHIFT}F`, when: "Always" },
  { command: "App: Save All", keys: `${MOD}S`, when: "Always" },
  { command: "App: New Window", keys: `${MOD}${SHIFT}N`, when: "Always" },
  { command: "App: Toggle Sidebar", keys: `${MOD}B`, when: "Always" },
  { command: "App: Switch Model", keys: `${MOD}.`, when: "Always" },
  { command: "Tab: New", keys: `${MOD}N`, when: "Always" },
  { command: "Tab: Next", keys: `${MOD}${SHIFT}]`, when: "Always" },
  { command: "Tab: Previous", keys: `${MOD}${SHIFT}[`, when: "Always" },
  { command: "Tab: Cycle Next", keys: `${CTRL}Tab`, when: "Always" },
  {
    command: "Tab: Cycle Previous",
    keys: `${CTRL}${SHIFT}Tab`,
    when: "Always",
  },
  { command: "Tab: Back", keys: `${MOD}[`, when: "Always" },
  { command: "Tab: Forward", keys: `${MOD}]`, when: "Always" },
  { command: "Tab: Activate 1–8", keys: `${MOD}1 … ${MOD}8`, when: "Always" },
  { command: "Tab: Activate Last", keys: `${MOD}9`, when: "Always" },
  { command: "Environment: Next", keys: `${MOD}${ALT}]`, when: "Always" },
  { command: "Environment: Previous", keys: `${MOD}${ALT}[`, when: "Always" },
  { command: "Environment: Activate 1–9", keys: `${MOD}${ALT}1 … ${MOD}${ALT}9`, when: "Always" },
  { command: "Pane: Close", keys: `${MOD}W`, when: "Always" },
  { command: "Pane: Split Right", keys: `${MOD}D`, when: "!editorFocus" },
  {
    command: "Pane: Split Down",
    keys: `${MOD}${SHIFT}D`,
    when: "!editorFocus",
  },
  { command: "Pane: Focus Left", keys: `${MOD}${ALT}←`, when: "Always" },
  { command: "Pane: Focus Right", keys: `${MOD}${ALT}→`, when: "Always" },
  { command: "Pane: Focus Up", keys: `${MOD}${ALT}↑`, when: "Always" },
  { command: "Pane: Focus Down", keys: `${MOD}${ALT}↓`, when: "Always" },
  { command: "Terminal: New", keys: `${MOD}\``, when: "Always" },
  { command: "Terminal: New Tab", keys: `${MOD}${SHIFT}\``, when: "Always" },
  { command: "Terminal: Toggle Dock", keys: `${MOD}J`, when: "deckLayout" },
  { command: "Editor: Find", keys: `${MOD}F`, when: "editorFocus" },
  { command: "Editor: Replace", keys: `${MOD}${ALT}F`, when: "editorFocus" },
];

export function filterKeybindings(
  rows: KeybindingRow[],
  query: string,
): KeybindingRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(
    (row) =>
      row.command.toLowerCase().includes(needle) ||
      row.keys.toLowerCase().includes(needle) ||
      row.when.toLowerCase().includes(needle),
  );
}

// ── editor ───────────────────────────────────────────────────────────

const AUTO_SAVE_KEY = "monocode.editor.autoSave";
export const AUTO_SAVE_DEFAULT = true;
export const AUTO_SAVE_CHANGE_EVENT = "monocode:auto-save-change";

export function loadAutoSave(): boolean {
  try {
    const raw = localStorage.getItem(AUTO_SAVE_KEY);
    if (raw == null) return AUTO_SAVE_DEFAULT;
    return raw === "1" || raw === "true";
  } catch {
    return AUTO_SAVE_DEFAULT;
  }
}

export function saveAutoSave(value: boolean) {
  try {
    localStorage.setItem(AUTO_SAVE_KEY, value ? "1" : "0");
  } catch {
    // private mode / quota
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<boolean>(AUTO_SAVE_CHANGE_EVENT, { detail: value }),
  );
}

export function subscribeAutoSave(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(AUTO_SAVE_CHANGE_EVENT, onStoreChange);
  return () => window.removeEventListener(AUTO_SAVE_CHANGE_EVENT, onStoreChange);
}

const FORMAT_ON_SAVE_KEY = "monocode.editor.formatOnSave";
export type FormatOnSave = { java: boolean; web: boolean };
export const FORMAT_ON_SAVE_DEFAULT: FormatOnSave = { java: false, web: false };
export const FORMAT_ON_SAVE_CHANGE_EVENT = "monocode:format-on-save-change";

export function loadFormatOnSave(): FormatOnSave {
  try {
    const raw = localStorage.getItem(FORMAT_ON_SAVE_KEY);
    if (!raw) return FORMAT_ON_SAVE_DEFAULT;
    const parsed = JSON.parse(raw) as Partial<FormatOnSave>;
    return {
      java: parsed.java === true,
      web: parsed.web === true,
    };
  } catch {
    return FORMAT_ON_SAVE_DEFAULT;
  }
}

export function saveFormatOnSave(value: FormatOnSave) {
  try {
    localStorage.setItem(FORMAT_ON_SAVE_KEY, JSON.stringify(value));
  } catch {
    // private mode / quota
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<FormatOnSave>(FORMAT_ON_SAVE_CHANGE_EVENT, { detail: value }),
  );
}

export function subscribeFormatOnSave(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(FORMAT_ON_SAVE_CHANGE_EVENT, onStoreChange);
  return () =>
    window.removeEventListener(FORMAT_ON_SAVE_CHANGE_EVENT, onStoreChange);
}

const GHOST_TEXT_KEY = "monocode.editor.ghostText";
export const GHOST_TEXT_DEFAULT = false;
export const GHOST_TEXT_CHANGE_EVENT = "monocode:ghost-text-change";

export function loadGhostText(): boolean {
  try {
    const raw = localStorage.getItem(GHOST_TEXT_KEY);
    if (raw == null) return GHOST_TEXT_DEFAULT;
    return raw === "1" || raw === "true";
  } catch {
    return GHOST_TEXT_DEFAULT;
  }
}

export function saveGhostText(value: boolean) {
  try {
    localStorage.setItem(GHOST_TEXT_KEY, value ? "1" : "0");
  } catch {
    // private mode / quota
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<boolean>(GHOST_TEXT_CHANGE_EVENT, { detail: value }),
  );
}

export function subscribeGhostText(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(GHOST_TEXT_CHANGE_EVENT, onStoreChange);
  return () => window.removeEventListener(GHOST_TEXT_CHANGE_EVENT, onStoreChange);
}

const MID_TURN_DEFAULT_KEY = "monocode.midTurnDefault";

/** What Enter does while a turn runs; ⌘Enter does the other one. */
export type MidTurnDefault = "queue" | "steer";

export const MID_TURN_DEFAULT: MidTurnDefault = "queue";

/** Fired on `window` when the mid-turn default flips. */
export const MID_TURN_DEFAULT_CHANGE_EVENT = "monocode:mid-turn-default-change";

export function loadMidTurnDefault(): MidTurnDefault {
  try {
    const raw = localStorage.getItem(MID_TURN_DEFAULT_KEY);
    return raw === "steer" ? "steer" : MID_TURN_DEFAULT;
  } catch {
    return MID_TURN_DEFAULT;
  }
}

export function saveMidTurnDefault(value: MidTurnDefault) {
  try {
    localStorage.setItem(MID_TURN_DEFAULT_KEY, value);
  } catch {
    // private mode / quota
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<MidTurnDefault>(MID_TURN_DEFAULT_CHANGE_EVENT, { detail: value }),
  );
}

export function subscribeMidTurnDefault(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(MID_TURN_DEFAULT_CHANGE_EVENT, onStoreChange);
  return () =>
    window.removeEventListener(MID_TURN_DEFAULT_CHANGE_EVENT, onStoreChange);
}
