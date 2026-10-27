import { requestSettings } from "./monaco/debugTab";
import { IS_MAC } from "./platform";

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
    description: "What new threads and plan builds start with.",
  },
  { id: "providers", group: "threads", label: "Providers", description: "The agent CLIs this machine can run." },
  {
    id: "orchestration",
    group: "threads",
    label: "Orchestration",
    description: "What threads that spawn subagents may do, and which models they may spawn.",
  },
  {
    id: "reviews",
    group: "threads",
    label: "Reviews",
    description: "A second model reads a branch before it lands. A project can override this from its settings.",
  },
  {
    id: "appshots",
    group: "threads",
    label: "Appshots",
    description: "Double-tap ⌘ over another app to drop its window into a chat.",
  },
  {
    id: "archive",
    group: "threads",
    label: "Archive",
    description: "Projects and threads you archived.",
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

/** Open Settings on one workspace's page (defaults, turn pass, accounts, build, rules, projects). */
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

// Key caps, one per key: macOS glyphs, words elsewhere.
const CMD = IS_MAC ? "⌘" : "Ctrl";
const OPT = IS_MAC ? "⌥" : "Alt";
const SHF = IS_MAC ? "⇧" : "Shift";
const CTL = IS_MAC ? "⌃" : "Ctrl";
const DEL = IS_MAC ? "⌫" : "Delete";
const RET = IS_MAC ? "⏎" : "Enter";

export type Keybinding = {
  name: string;
  /** Each entry is one chord as caps; a second entry is an alternative. */
  keys: string[][];
  /** Where the binding holds, when not everywhere. */
  scope?: "editor" | "outside-editor" | "files";
};

export type KeybindingGroup = { title: string; bindings: Keybinding[] };

/**
 * Mirrors the bindings we actually handle: the command map in
 * lib/appCommands.ts (native menu accelerators, `tabCommand`, window keys).
 */
export const KEYBINDING_GROUPS: KeybindingGroup[] = [
  {
    title: "App",
    bindings: [
      { name: "Search", keys: [[CMD, "K"]] },
      { name: "Go to File", keys: [[CMD, "P"], [SHF, SHF]] },
      { name: "Open Project", keys: [[CMD, "O"]] },
      { name: "Go to Symbol", keys: [[CMD, SHF, "O"]] },
      { name: "Type Hierarchy", keys: [[CMD, "T"]] },
      { name: "Find in Files", keys: [[CMD, SHF, "F"]] },
      { name: "Save All", keys: [[CMD, "S"]] },
      { name: "New Window", keys: [[CMD, SHF, "N"]] },
      { name: "Sidebar", keys: [[CMD, "B"]] },
      { name: "Panel", keys: [[CMD, SHF, "R"]] },
      { name: "Switch Model", keys: [[CMD, "."]] },
    ],
  },
  {
    title: "Tabs",
    bindings: [
      { name: "New Thread", keys: [[CMD, "N"]] },
      { name: "Next", keys: [[CMD, SHF, "]"]] },
      { name: "Previous", keys: [[CMD, SHF, "["]] },
      { name: "Cycle Next", keys: [[CTL, "Tab"]] },
      { name: "Cycle Previous", keys: [[CTL, SHF, "Tab"]] },
      { name: "Back", keys: [[CMD, "["]] },
      { name: "Forward", keys: [[CMD, "]"]] },
      { name: "Activate 1 to 8", keys: [[CMD, "1–8"]] },
      { name: "Activate Last", keys: [[CMD, "9"]] },
    ],
  },
  {
    title: "Hosts",
    bindings: [
      { name: "Next Host", keys: [[CMD, OPT, "]"]] },
      { name: "Previous Host", keys: [[CMD, OPT, "["]] },
      { name: "Activate 1 to 9", keys: [[CMD, OPT, "1–9"]] },
    ],
  },
  {
    title: "Panes",
    bindings: [
      { name: "Close", keys: [[CMD, "W"]] },
      { name: "Split Right", keys: [[CMD, "D"]], scope: "outside-editor" },
      { name: "Split Down", keys: [[CMD, SHF, "D"]], scope: "outside-editor" },
      { name: "Focus Left", keys: [[CMD, OPT, "←"]] },
      { name: "Focus Right", keys: [[CMD, OPT, "→"]] },
      { name: "Focus Up", keys: [[CMD, OPT, "↑"]] },
      { name: "Focus Down", keys: [[CMD, OPT, "↓"]] },
    ],
  },
  {
    title: "Terminal",
    bindings: [
      { name: "New", keys: [[CTL, "`"]] },
      { name: "New Tab", keys: [[CTL, SHF, "`"]] },
      { name: "Show or Hide", keys: [[CMD, "J"]] },
    ],
  },
  {
    title: "Files",
    bindings: [
      { name: "Cut", keys: [[CMD, "X"]], scope: "files" },
      { name: "Copy", keys: [[CMD, "C"]], scope: "files" },
      { name: "Paste", keys: [[CMD, "V"]], scope: "files" },
      { name: "Rename", keys: [["F2"]], scope: "files" },
      { name: "Delete", keys: [[DEL]], scope: "files" },
      { name: "Open in Editor", keys: [[OPT, RET]], scope: "files" },
    ],
  },
  {
    title: "Editor",
    bindings: [
      { name: "Find", keys: [[CMD, "F"]], scope: "editor" },
      { name: "Replace", keys: [[CMD, OPT, "F"]], scope: "editor" },
    ],
  },
];

/** The first chord of a binding as one key cap's text ("⌘W" on macOS,
 *  "Ctrl+W" elsewhere): the only source of a shortcut a menu row or a `Tip`
 *  shows, so a hint never names a key the app does not handle
 *  (lib/menuShortcuts.test.ts holds every call to a real binding). */
export function shortcutFor(group: string, name: string): string | undefined {
  const chord = KEYBINDING_GROUPS.find((g) => g.title === group)?.bindings.find((b) => b.name === name)?.keys[0];
  return chord?.join(IS_MAC ? "" : "+");
}

export const KEYBINDING_SCOPE_LABEL: Record<NonNullable<Keybinding["scope"]>, string> = {
  editor: "In the editor",
  "outside-editor": "Outside the editor",
  files: "In the file tree",
};

/** The groups with only the bindings whose name, group or keys match;
 *  a group with none left is dropped. Keys match typed with or without spaces. */
export function filterKeybindings(groups: KeybindingGroup[], query: string): KeybindingGroup[] {
  const needle = query.trim().toLowerCase().replace(/\s+/g, "");
  if (!needle) return groups;
  return groups
    .map((group) => ({
      ...group,
      bindings: group.bindings.filter((binding) =>
        [group.title, binding.name, ...binding.keys.map((chord) => chord.join(""))].some((text) =>
          text.toLowerCase().replace(/\s+/g, "").includes(needle),
        ),
      ),
    }))
    .filter((group) => group.bindings.length > 0);
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

/** What Enter does while a turn runs; ⌘Enter does the other one. Steer by
 *  default: a follow-up reaches the running turn now (and releases a
 *  wait_for_agent the thread sits in); a stored preference wins. */
export type MidTurnDefault = "queue" | "steer";

export const MID_TURN_DEFAULT: MidTurnDefault = "steer";

/** Fired on `window` when the mid-turn default flips. */
export const MID_TURN_DEFAULT_CHANGE_EVENT = "monocode:mid-turn-default-change";

export function loadMidTurnDefault(): MidTurnDefault {
  try {
    const raw = localStorage.getItem(MID_TURN_DEFAULT_KEY);
    return raw === "steer" || raw === "queue" ? raw : MID_TURN_DEFAULT;
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
