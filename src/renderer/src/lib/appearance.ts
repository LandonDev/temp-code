import { invoke } from "./native";
import { IS_MAC } from "./platform";

const THEME_HUE_KEY = "monocode.themeHue";
const THEME_SATURATION_KEY = "monocode.themeSaturation";
const OPACITY_KEY = "monocode.sidebarOpacity";
const OPEN_KEY = "monocode.sidebarOpen";
const PROJECT_RAIL_OPEN_KEY = "monocode.projectRailOpen";
const BODY_KEY = "monocode.bodyGlass";
const GLASS_KEY = "monocode.glass";
const SCHEME_KEY = "monocode.colorScheme";
const SIDEBAR_TAB_ORDER_KEY = "monocode.sidebarTabOrder";
const PROJECT_RAIL_WIDTH_KEY = "monocode.projectRailWidth";
const SIDEBAR_LAYOUT_KEY = "monocode.sidebarLayout";
const TRANSCRIPT_LAYOUT_KEY = "monocode.transcriptLayout";
const TRANSCRIPT_ZEN_KEY = "monocode.transcriptZen";
const TRANSCRIPT_ANCHOR_KEY = "monocode.transcriptAnchor";

export type ColorScheme = "dark" | "light";
export type ThemePreference = ColorScheme | "system";
export type SidebarLayout = "classic" | "deck";
export type TranscriptLayout = "full" | "chat";

export const THEME_PREFERENCE_DEFAULT: ThemePreference = "dark";

/** Fired on `window` whenever the color scheme flips (detail: ColorScheme). */
export const SCHEME_CHANGE_EVENT = "monocode:schemechange";

/** Fired on `window` whenever the sidebar layout flips (detail: SidebarLayout). */
export const LAYOUT_CHANGE_EVENT = "monocode:layoutchange";

export const SIDEBAR_LAYOUT_DEFAULT: SidebarLayout = "deck";

export const TRANSCRIPT_LAYOUT_DEFAULT: TranscriptLayout = "full";

export const TRANSCRIPT_ZEN_DEFAULT = true;

export const TRANSCRIPT_ANCHOR_DEFAULT = true;

/** Fired on `window` whenever zen mode flips (detail: boolean). */
export const TRANSCRIPT_ZEN_CHANGE_EVENT = "monocode:transcriptzenchange";

/** Fired on `window` whenever prompt-to-top anchoring flips (detail: boolean). */
export const TRANSCRIPT_ANCHOR_CHANGE_EVENT = "monocode:transcriptanchorchange";

/** Fired on `window` whenever the transcript layout flips (detail: TranscriptLayout). */
export const TRANSCRIPT_LAYOUT_CHANGE_EVENT = "monocode:transcriptlayoutchange";

export type SidebarTabId = "files" | "sessions" | "changes" | "inbox";

const DEFAULT_SIDEBAR_TAB_ORDER: SidebarTabId[] = [
  "sessions",
  "inbox",
  "files",
  "changes",
];

export const THEME_HUE_MIN = 0;
export const THEME_HUE_MAX = 360;
export const THEME_HUE_DEFAULT = 240;

export const THEME_SATURATION_MIN = 0;
export const THEME_SATURATION_MAX = 100;
export const THEME_SATURATION_DEFAULT = 0;

export const SIDEBAR_OPACITY_MIN = 0.15;
export const SIDEBAR_OPACITY_MAX = 1;
export const SIDEBAR_OPACITY_DEFAULT = 0.8;


export const PROJECT_RAIL_WIDTH_MIN = 180;
export const PROJECT_RAIL_WIDTH_MAX = 360;
export const PROJECT_RAIL_WIDTH_DEFAULT = 200;

export const BODY_GLASS_DEFAULT = false;

export const GLASS_DEFAULT = true;

/** Fired on `window` whenever the effective glass state flips (detail: boolean). */
export const GLASS_CHANGE_EVENT = "monocode:glasschange";

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

export function loadThemeHue(): number {
  return Math.round(
    clamp(
      readNumber(THEME_HUE_KEY) ?? THEME_HUE_DEFAULT,
      THEME_HUE_MIN,
      THEME_HUE_MAX,
    ),
  );
}

export function saveThemeHue(value: number) {
  writeNumber(
    THEME_HUE_KEY,
    Math.round(clamp(value, THEME_HUE_MIN, THEME_HUE_MAX)),
  );
}

export function loadThemeSaturation(): number {
  return Math.round(
    clamp(
      readNumber(THEME_SATURATION_KEY) ?? THEME_SATURATION_DEFAULT,
      THEME_SATURATION_MIN,
      THEME_SATURATION_MAX,
    ),
  );
}

export function saveThemeSaturation(value: number) {
  writeNumber(
    THEME_SATURATION_KEY,
    Math.round(
      clamp(value, THEME_SATURATION_MIN, THEME_SATURATION_MAX),
    ),
  );
}

export function applyThemeTint(hue: number, saturation: number) {
  const nextHue = Math.round(clamp(hue, THEME_HUE_MIN, THEME_HUE_MAX));
  const nextSaturation = Math.round(
    clamp(saturation, THEME_SATURATION_MIN, THEME_SATURATION_MAX),
  );
  document.documentElement.style.setProperty("--theme-hue", String(nextHue));
  document.documentElement.style.setProperty(
    "--theme-saturation",
    `${nextSaturation}%`,
  );
  return { hue: nextHue, saturation: nextSaturation };
}

export function initAppearance() {
  document.documentElement.classList.toggle("is-mac", IS_MAC);
  applyThemeTint(loadThemeHue(), loadThemeSaturation());
  applyThemePreference(loadThemePreference());
  watchSystemColorScheme();
  applySidebarOpacity(loadSidebarOpacity());
  applyBodyGlass(loadBodyGlass());
  // html/body/#root stay opaque until the first paint: main.tsx adds
  // `html.ready` and calls syncWindowGlass() when it dismisses the splash.
  applyGlassClass(effectiveGlass(loadGlass()));
  watchReducedTransparency();
  window.addEventListener(SCHEME_CHANGE_EVENT, () => {
    if (windowGlassSynced && !isGlassOn()) syncWindowGlass();
  });
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
  document.documentElement.classList.toggle("theme-light", next === "light");
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

export function loadSidebarOpacity(): number {
  return clamp(
    readNumber(OPACITY_KEY) ?? SIDEBAR_OPACITY_DEFAULT,
    SIDEBAR_OPACITY_MIN,
    SIDEBAR_OPACITY_MAX,
  );
}

export function saveSidebarOpacity(value: number) {
  writeNumber(
    OPACITY_KEY,
    clamp(value, SIDEBAR_OPACITY_MIN, SIDEBAR_OPACITY_MAX),
  );
}

export function applySidebarOpacity(value: number) {
  const next = clamp(value, SIDEBAR_OPACITY_MIN, SIDEBAR_OPACITY_MAX);
  document.documentElement.style.setProperty("--sidebar-opacity", String(next));
  return next;
}

export function loadGlass(): boolean {
  return readFlag(GLASS_KEY) ?? GLASS_DEFAULT;
}

export function saveGlass(value: boolean) {
  writeFlag(GLASS_KEY, value);
  // Main mirrors it: the next window is created with vibrancy only if it
  // is on, and an alpha background cannot be added to a window later.
  if (IS_MAC) void invoke("set_window_glass_pref", { on: value });
}

/** Toggles the translucent chrome and the window's vibrancy together. */
export function applyGlass(value: boolean) {
  applyGlassClass(effectiveGlass(value));
  syncWindowGlass(value);
  return value;
}

/** True when the sidebar chrome shows the desktop through: the setting is on
 *  and the OS is not asking for reduced transparency. */
export function isGlassOn(): boolean {
  return effectiveGlass(loadGlass());
}

let windowGlassSynced = false;

/** Applies or removes the window's vibrancy to match the effective glass
 *  state. Call once after the first paint, then on every flip. */
export function syncWindowGlass(setting = loadGlass()) {
  windowGlassSynced = true;
  if (!IS_MAC) return;
  if (effectiveGlass(setting)) {
    void invoke("enable_window_glass");
  } else {
    void invoke("disable_window_glass", { color: themeBackgroundHex() });
  }
}

function reducedTransparencyQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-transparency: reduce)")
    : null;
}

function effectiveGlass(setting: boolean): boolean {
  return setting && !reducedTransparencyQuery()?.matches;
}

function applyGlassClass(on: boolean) {
  document.documentElement.classList.toggle("glass", on);
  window.dispatchEvent(new CustomEvent<boolean>(GLASS_CHANGE_EVENT, { detail: on }));
}

function watchReducedTransparency() {
  reducedTransparencyQuery()?.addEventListener("change", () => {
    applyGlassClass(effectiveGlass(loadGlass()));
    if (windowGlassSynced) syncWindowGlass();
  });
}

/** The theme's base background as a hex colour, for the opaque window. */
function themeBackgroundHex(): string {
  const style = getComputedStyle(document.documentElement);
  const hue = Number.parseFloat(style.getPropertyValue("--theme-hue")) || 0;
  const sat =
    (Number.parseFloat(style.getPropertyValue("--theme-saturation")) || 0) /
    100;
  const light =
    (Number.parseFloat(style.getPropertyValue("--background-lightness")) ||
      9) / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const channel = (n: number) =>
    Math.round(
      255 * (light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))),
    )
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

export function loadBodyGlass(): boolean {
  return readFlag(BODY_KEY) ?? BODY_GLASS_DEFAULT;
}

export function saveBodyGlass(value: boolean) {
  writeFlag(BODY_KEY, value);
}

export function applyBodyGlass(value: boolean) {
  document.documentElement.classList.toggle("glass-body", value);
  return value;
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

function isSidebarLayout(value: unknown): value is SidebarLayout {
  return value === "classic" || value === "deck";
}

export function loadSidebarLayout(): SidebarLayout {
  try {
    const raw = localStorage.getItem(SIDEBAR_LAYOUT_KEY);
    return isSidebarLayout(raw) ? raw : SIDEBAR_LAYOUT_DEFAULT;
  } catch {
    return SIDEBAR_LAYOUT_DEFAULT;
  }
}

export function saveSidebarLayout(value: SidebarLayout) {
  try {
    localStorage.setItem(SIDEBAR_LAYOUT_KEY, value);
  } catch {
    // private mode / quota
  }
  window.dispatchEvent(
    new CustomEvent<SidebarLayout>(LAYOUT_CHANGE_EVENT, { detail: value }),
  );
}

function isTranscriptLayout(value: unknown): value is TranscriptLayout {
  return value === "full" || value === "chat";
}

export function loadTranscriptLayout(): TranscriptLayout {
  try {
    const raw = localStorage.getItem(TRANSCRIPT_LAYOUT_KEY);
    return isTranscriptLayout(raw) ? raw : TRANSCRIPT_LAYOUT_DEFAULT;
  } catch {
    return TRANSCRIPT_LAYOUT_DEFAULT;
  }
}

export function saveTranscriptLayout(value: TranscriptLayout) {
  const next = isTranscriptLayout(value) ? value : TRANSCRIPT_LAYOUT_DEFAULT;
  try {
    localStorage.setItem(TRANSCRIPT_LAYOUT_KEY, next);
  } catch {
    // private mode / quota
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<TranscriptLayout>(TRANSCRIPT_LAYOUT_CHANGE_EVENT, {
      detail: next,
    }),
  );
}

export function loadTranscriptZen(): boolean {
  return readFlag(TRANSCRIPT_ZEN_KEY) ?? TRANSCRIPT_ZEN_DEFAULT;
}

export function saveTranscriptZen(value: boolean) {
  writeFlag(TRANSCRIPT_ZEN_KEY, value);
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<boolean>(TRANSCRIPT_ZEN_CHANGE_EVENT, { detail: value }),
  );
}

export function toggleTranscriptZen(): boolean {
  const next = !loadTranscriptZen();
  saveTranscriptZen(next);
  return next;
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
