import { ALT, IS_MAC, MOD, SHIFT } from "./platform";

const SECTION_KEY = "monocode.settingsSection";

export type SettingsSectionId =
  | "general"
  | "appearance"
  | "editor"
  | "keybindings"
  | "providers"
  | "orchestration"
  | "build"
  | "archive";

export const SETTINGS_SECTIONS: {
  id: SettingsSectionId;
  label: string;
  description: string;
}[] = [
  {
    id: "general",
    label: "General",
    description: "App-wide behavior, tool summaries, and the release you are running.",
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Theme, translucency, and the tint applied to the chrome.",
  },
  {
    id: "editor",
    label: "Editor",
    description: "Saving, formatting, ghost text, and the language servers behind the editor.",
  },
  {
    id: "keybindings",
    label: "Keybindings",
    description:
      "Every shortcut the workspace handles, from the app menu and the key handler.",
  },
  {
    id: "providers",
    label: "Providers",
    description:
      "Agent CLIs TempCode can drive, and the model new sessions start with.",
  },
  {
    id: "orchestration",
    label: "Orchestration",
    description:
      "What threads that spawn subagents may do themselves, which models they may spawn, and where each kind of work goes.",
  },
  {
    id: "build",
    label: "Build",
    description:
      "The command the Build rail tab runs for a workspace, and the files it produces. Projects can override it in their settings.",
  },
  {
    id: "archive",
    label: "Archive",
    description: "Archived projects and threads from every project. Restore one to keep working in it.",
  },
];

export const SETTINGS_SECTION_DEFAULT: SettingsSectionId = "general";

export function isSettingsSectionId(
  value: unknown,
): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}

export function settingsSectionLabel(id: SettingsSectionId): string {
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
    const raw = localStorage.getItem(SECTION_KEY);
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
 * Mirrors the bindings we actually handle: the native menu accelerators in
 * `src-tauri/src/menu.rs`, `tabCommand`, and the window key handler in App.
 */
export const KEYBINDINGS: KeybindingRow[] = [
  { command: "App: Search", keys: `${MOD}K`, when: "Always" },
  { command: "App: Go to File", keys: `${MOD}P`, when: "Always" },
  { command: "App: Find in Files", keys: `${MOD}${SHIFT}F`, when: "Always" },
  { command: "App: Open Project", keys: `${MOD}O`, when: "Always" },
  { command: "App: New Window", keys: `${MOD}${SHIFT}N`, when: "Always" },
  { command: "App: Toggle Sidebar", keys: `${MOD}B`, when: "Always" },
  { command: "App: Toggle Zen Mode", keys: `${MOD}${ALT}Z`, when: "Always" },
  { command: "App: Switch Model", keys: `${MOD}.`, when: "Always" },
  { command: "Tab: New", keys: `${MOD}T`, when: "Always" },
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

// Tool summaries: a small fast model describes each finished tool section.
// Same localStorage keys as the pre-transplant renderer so the server-side
// summariser's settings survive the swap (M6a reads them when it lands).
const TOOL_SUMMARIES_KEY = "tool-summaries";
const TOOL_CAPTIONS_KEY = "tool-captions";
const SUMMARY_MODEL_KEY = "summary-model";

export type SummaryModel = "auto" | "haiku" | "spark";

export const SUMMARY_MODELS: { value: SummaryModel; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "haiku", label: "Haiku 4.5" },
  { value: "spark", label: "Spark" },
];

function loadOnOff(key: string): boolean {
  try {
    return localStorage.getItem(key) !== "off";
  } catch {
    return true;
  }
}

function saveOnOff(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {
    // private mode / quota
  }
}

export const loadToolSummaries = () => loadOnOff(TOOL_SUMMARIES_KEY);
export const saveToolSummaries = (on: boolean) => saveOnOff(TOOL_SUMMARIES_KEY, on);
export const loadToolCaptions = () => loadOnOff(TOOL_CAPTIONS_KEY);
export const saveToolCaptions = (on: boolean) => saveOnOff(TOOL_CAPTIONS_KEY, on);

export function loadSummaryModel(): SummaryModel {
  try {
    const raw = localStorage.getItem(SUMMARY_MODEL_KEY);
    return SUMMARY_MODELS.some((m) => m.value === raw) ? (raw as SummaryModel) : "auto";
  } catch {
    return "auto";
  }
}

export function saveSummaryModel(value: SummaryModel) {
  try {
    localStorage.setItem(SUMMARY_MODEL_KEY, value);
  } catch {
    // private mode / quota
  }
}
