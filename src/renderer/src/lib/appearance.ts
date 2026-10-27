import { IS_MAC } from "./platform";

const OPEN_KEY = "monocode.sidebarOpen";
const PROJECT_RAIL_OPEN_KEY = "monocode.projectRailOpen";
const SCHEME_KEY = "monocode.colorScheme";
const SIDEBAR_TAB_ORDER_KEY = "monocode.sidebarTabOrder";
const PROJECT_RAIL_WIDTH_KEY = "monocode.projectRailWidth";
const TRANSCRIPT_ANCHOR_KEY = "monocode.transcriptAnchor";
const EDITOR_FONT_SIZE_KEY = "monocode.editorFontSize";

/** Keys of settings that are gone: the tint, Glass, sidebar opacity, main-pane
 *  glass, the Classic layout and the two transcript toggles A7 retired. Boot
 *  clears them. */
const RETIRED_KEYS = [
  "monocode.themeHue",
  "monocode.themeSaturation",
  "monocode.sidebarOpacity",
  "monocode.bodyGlass",
  "monocode.glass",
  "monocode.sidebarLayout",
  "monocode.transcriptLayout",
  "monocode.transcriptZen",
];

export type ColorScheme = "dark" | "light";
export type ThemePreference = ColorScheme | "system";
/** The shell store's layout parameter; every window is the deck since Classic left. */
export type SidebarLayout = "classic" | "deck";

export const THEME_PREFERENCE_DEFAULT: ThemePreference = "dark";

/** Fired on `window` whenever the color scheme flips (detail: ColorScheme). */
export const SCHEME_CHANGE_EVENT = "monocode:schemechange";



export const TRANSCRIPT_ANCHOR_DEFAULT = true;

/** Fired on `window` whenever prompt-to-top anchoring flips (detail: boolean). */
export const TRANSCRIPT_ANCHOR_CHANGE_EVENT = "monocode:transcriptanchorchange";

export type SidebarTabId = "files" | "sessions" | "changes" | "inbox";

const DEFAULT_SIDEBAR_TAB_ORDER: SidebarTabId[] = [
  "sessions",
  "inbox",
  "files",
  "changes",
];

export const PROJECT_RAIL_WIDTH_MIN = 180;
export const PROJECT_RAIL_WIDTH_MAX = 360;
export const PROJECT_RAIL_WIDTH_DEFAULT = 200;

/** The editor's type sizes, CodeMirror's and Monaco's alike. */
export const EDITOR_FONT_SIZES = [12, 13, 14] as const;
export type EditorFontSize = (typeof EDITOR_FONT_SIZES)[number];
export const EDITOR_FONT_SIZE_DEFAULT: EditorFontSize = 13;

/** Fired on `window` whenever the editor's type size changes (detail: EditorFontSize). */
export const EDITOR_FONT_CHANGE_EVENT = "monocode:editorfontchange";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readNumber(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeNumber(key: string, value: number) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // private mode / quota
  }
}

function readFlag(key: string): boolean | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    return raw === "1" || raw === "true";
  } catch {
    return null;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // private mode / quota
  }
}

export function initAppearance() {
  document.documentElement.classList.toggle("is-mac", IS_MAC);
  clearRetiredKeys();
  applyThemePreference(loadThemePreference());
  watchSystemColorScheme();
  applyEditorFontSize(loadEditorFontSize());
}

function clearRetiredKeys() {
  try {
    for (const key of RETIRED_KEYS) localStorage.removeItem(key);
  } catch {
    // private mode
  }
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "dark" || value === "light" || value === "system";
}

export function loadThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(SCHEME_KEY);
    return isThemePreference(raw) ? raw : THEME_PREFERENCE_DEFAULT;
  } catch {
    return THEME_PREFERENCE_DEFAULT;
  }
}

export function saveThemePreference(value: ThemePreference) {
  try {
    localStorage.setItem(SCHEME_KEY, value);
  } catch {
    // private mode / quota
  }
}

function systemQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || !window.matchMedia) return null;
  return window.matchMedia("(prefers-color-scheme: light)");
}

function systemColorScheme(): ColorScheme {
  return systemQuery()?.matches ? "light" : "dark";
}

export function resolveColorScheme(value: ThemePreference): ColorScheme {
  return value === "system" ? systemColorScheme() : value;
}

export function isLightScheme(): boolean {
  return document.documentElement.classList.contains("theme-light");
}

export function applyThemePreference(value: ThemePreference): ColorScheme {
  const next = resolveColorScheme(value);
  const root = document.documentElement;
  if (root.classList.contains("theme-light") !== (next === "light")) {
    // Every colour changes at once; with transitions on, the flip smears.
    // Off for one frame, a forced style read so the swap lands without them.
    root.classList.add("theme-switching");
    root.classList.toggle("theme-light", next === "light");
    void getComputedStyle(root).opacity;
    requestAnimationFrame(() => root.classList.remove("theme-switching"));
  }
  window.dispatchEvent(
    new CustomEvent<ColorScheme>(SCHEME_CHANGE_EVENT, { detail: next }),
  );
  return next;
}

/** Keeps the "system" preference in sync when the OS flips appearance. */
export function watchSystemColorScheme() {
  const query = systemQuery();
  if (!query) return;
  query.addEventListener("change", () => {
    const preference = loadThemePreference();
    if (preference === "system") applyThemePreference(preference);
  });
}

function isSidebarTabId(value: unknown): value is SidebarTabId {
  return (
    value === "files" ||
    value === "sessions" ||
    value === "changes" ||
    value === "inbox"
  );
}

export function loadSidebarOpen(): boolean {
  return readFlag(OPEN_KEY) ?? false;
}

export function saveSidebarOpen(value: boolean) {
  writeFlag(OPEN_KEY, value);
}

export function loadProjectRailOpen(): boolean {
  return readFlag(PROJECT_RAIL_OPEN_KEY) ?? true;
}

export function saveProjectRailOpen(value: boolean) {
  writeFlag(PROJECT_RAIL_OPEN_KEY, value);
}

export function loadSidebarTabOrder(): SidebarTabId[] {
  try {
    const raw = localStorage.getItem(SIDEBAR_TAB_ORDER_KEY);
    if (!raw) return [...DEFAULT_SIDEBAR_TAB_ORDER];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_SIDEBAR_TAB_ORDER];
    const next = parsed.filter(isSidebarTabId);
    for (const id of DEFAULT_SIDEBAR_TAB_ORDER) {
      if (!next.includes(id)) next.push(id);
    }
    return next.length === DEFAULT_SIDEBAR_TAB_ORDER.length
      ? next
      : [...DEFAULT_SIDEBAR_TAB_ORDER];
  } catch {
    return [...DEFAULT_SIDEBAR_TAB_ORDER];
  }
}

export function saveSidebarTabOrder(order: SidebarTabId[]) {
  try {
    localStorage.setItem(SIDEBAR_TAB_ORDER_KEY, JSON.stringify(order));
  } catch {
    // private mode / quota
  }
}

export function loadProjectRailWidth(): number {
  return Math.round(
    clamp(
      readNumber(PROJECT_RAIL_WIDTH_KEY) ?? PROJECT_RAIL_WIDTH_DEFAULT,
      PROJECT_RAIL_WIDTH_MIN,
      PROJECT_RAIL_WIDTH_MAX,
    ),
  );
}

export function saveProjectRailWidth(value: number) {
  writeNumber(
    PROJECT_RAIL_WIDTH_KEY,
    Math.round(
      clamp(value, PROJECT_RAIL_WIDTH_MIN, PROJECT_RAIL_WIDTH_MAX),
    ),
  );
}

export function loadTranscriptAnchor(): boolean {
  return readFlag(TRANSCRIPT_ANCHOR_KEY) ?? TRANSCRIPT_ANCHOR_DEFAULT;
}

export function saveTranscriptAnchor(value: boolean) {
  writeFlag(TRANSCRIPT_ANCHOR_KEY, value);
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<boolean>(TRANSCRIPT_ANCHOR_CHANGE_EVENT, {
      detail: value,
    }),
  );
}

function isEditorFontSize(value: unknown): value is EditorFontSize {
  return EDITOR_FONT_SIZES.includes(value as EditorFontSize);
}

export function loadEditorFontSize(): EditorFontSize {
  const raw = readNumber(EDITOR_FONT_SIZE_KEY);
  return isEditorFontSize(raw) ? raw : EDITOR_FONT_SIZE_DEFAULT;
}

/** Saves the nearest size on the list and applies it. */
export function saveEditorFontSize(value: number): EditorFontSize {
  const next = EDITOR_FONT_SIZES.reduce((best, size) => (Math.abs(size - value) < Math.abs(best - value) ? size : best));
  writeNumber(EDITOR_FONT_SIZE_KEY, next);
  applyEditorFontSize(next);
  return next;
}

/** CodeMirror reads `--font-size-code`; Monaco's mounts follow the event. */
export function applyEditorFontSize(size: EditorFontSize) {
  document.documentElement.style.setProperty("--font-size-code", `${size}px`);
  window.dispatchEvent(new CustomEvent<EditorFontSize>(EDITOR_FONT_CHANGE_EVENT, { detail: size }));
}

/** Monaco's size and line height for the editor's type size. */
export function editorFontOptions(size: EditorFontSize = loadEditorFontSize()): { fontSize: number; lineHeight: number } {
  return { fontSize: size, lineHeight: { 12: 18, 13: 20, 14: 22 }[size] };
}
