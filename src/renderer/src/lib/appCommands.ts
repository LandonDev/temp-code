/**
 * The command map. Every app-level command has one id here, and both
 * routes into the app resolve to that id:
 *
 *   - DOM: App.tsx's window-capture keydown calls `createKeyResolver()`
 *     and dispatches whatever it returns.
 *   - Native menu: `src/main/menu-tree.ts` items carry the same ids and
 *     arrive over `native:menu` (`listen(id)` in lib/native.ts);
 *     `menuCommandAllowed` applies the same overlay guard.
 *
 * Handlers live in App.tsx (they close over its state); `window.__app`
 * (lib/appFacade.ts, dev builds) exposes `run(id)` for CDP tests, so a
 * command added here is reachable from all three routes at once.
 *
 * Guards, in order:
 *   1. Lightbox open: Escape / ← / → become the lightbox commands and
 *      nothing else fires but zoom.
 *   2. Inside a dialog (`role="dialog"`, `.modal-panel`): only
 *      DIALOG_SAFE commands (zoom, Save All, update check) fire.
 *   3. A focused Monaco keeps its own chords (⌘P parameter info, ⌃T, ⌃D,
 *      ⌃H, ⌃⌥H); lib/editorKeys.ts stops ⌘P before we see it.
 *   4. A focused terminal keeps every ctrl-only chord for the shell.
 *   5. Double Shift is dropped in the terminal and inside CodeMirror.
 *
 * Keys:
 *   Shift Shift (400 ms)  go_to_file        ⌘P        go_to_file
 *   ⌘O                    go_to_symbol      ⌘T        show_hierarchy
 *   ⌘S                    save_all          ⌘N        new_tab
 *   ⌘K open_search  ⌘B toggle_sidebar  ⌘⌥Z toggle_zen  ⌘, open_settings
 *   ⌘⇧F find_in_project  ⌘⇧N new_window  ⌘= / ⌘- / ⌘0 zoom
 *   Tab and pane chords: lib/tabKeys.ts (⌘W ⌘D ⌘⇧D ⌘J ⌘[ ⌘] ⌘1–9 ⌘` …)
 *   Open Project has no key; it stays in the File menu.
 */

import { insideMonaco, isEditorChord } from "./editorKeys";
import { tabCommand, type TabCommand } from "./tabKeys";

export const APP_COMMANDS = [
  "new_tab",
  "close_tab",
  "next_tab",
  "prev_tab",
  "back_tab",
  "forward_tab",
  "activate_tab",
  "split_right",
  "split_down",
  "new_terminal",
  "new_terminal_tab",
  "toggle_terminal",
  "focus_left",
  "focus_right",
  "focus_up",
  "focus_down",
  "toggle_sidebar",
  "toggle_zen",
  "open_project",
  "go_to_file",
  "go_to_symbol",
  "show_hierarchy",
  "save_all",
  "open_search",
  "open_inbox",
  "open_notes",
  "open_settings",
  "check_for_updates",
  "sidebar_opacity",
  "find_in_project",
  "new_window",
  "find",
  "open_model_picker",
  "zoom_in",
  "zoom_out",
  "zoom_reset",
  "lightbox_close",
  "lightbox_prev",
  "lightbox_next",
] as const;

export type AppCommandId = (typeof APP_COMMANDS)[number];

/** `index` rides along with `activate_tab` (0-based; -1 = last). */
export type AppCommand = { id: AppCommandId; index?: number };

export function isAppCommandId(id: string): id is AppCommandId {
  return (APP_COMMANDS as readonly string[]).includes(id);
}

/** Commands that touch nothing under an open dialog or lightbox. */
export const DIALOG_SAFE: ReadonlySet<AppCommandId> = new Set<AppCommandId>([
  "zoom_in",
  "zoom_out",
  "zoom_reset",
  "save_all",
  "check_for_updates",
]);

export const DOUBLE_SHIFT_MS = 400;

const DIALOG = '[role="dialog"], .modal-panel';
const TERMINAL = ".monocode-terminal";
const CODEMIRROR = ".cm-editor";
const PICKER =
  "[data-model-picker], [data-file-picker], [data-symbol-picker], [data-branch-picker], [data-command-popover], [data-app-search]";

export type KeyContext = {
  lightboxOpen: boolean;
  /** Toggle Terminal only exists in the deck layout. */
  terminalToggle?: boolean;
};

type Closest = { closest?: (selector: string) => unknown };
const within = (target: EventTarget | null, selector: string): boolean => {
  const el = target as Closest | null;
  return typeof el?.closest === "function" && !!el.closest(selector);
};

const isMac = (): boolean =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Chords a focused Monaco runs itself (see MonacoPane.tsx addCommand). */
function monacoOwns(e: KeyboardEvent): boolean {
  if (isEditorChord(e)) return true;
  if (!e.ctrlKey || e.metaKey) return false;
  const key = e.key.toLowerCase();
  return key === "t" || key === "d" || key === "h";
}

function fromTabCommand(cmd: TabCommand): AppCommand {
  if (typeof cmd === "object") {
    if ("focus" in cmd) return { id: `focus_${cmd.focus}` as AppCommandId };
    return { id: "activate_tab", index: cmd.activate };
  }
  const map: Record<Exclude<TabCommand, object>, AppCommandId> = {
    new: "new_tab",
    close: "close_tab",
    next: "next_tab",
    prev: "prev_tab",
    back: "back_tab",
    forward: "forward_tab",
    "split-right": "split_right",
    "split-down": "split_down",
    "new-terminal": "new_terminal",
    "new-terminal-tab": "new_terminal_tab",
    "toggle-terminal": "toggle_terminal",
  };
  return { id: map[cmd] };
}

function zoomChord(e: KeyboardEvent): AppCommandId | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  if (e.key === "=" || e.key === "+" || e.code === "Equal") return "zoom_in";
  if (e.key === "-" || e.code === "Minus") return "zoom_out";
  if (e.key === "0" || e.code === "Digit0") return "zoom_reset";
  return null;
}

/**
 * Resolve keydowns to commands. Stateful for the double-Shift timer, so
 * build one per listener. Returns null when the key is not ours or a
 * guard says the focused surface owns it.
 */
export function createKeyResolver(now: () => number = () => performance.now()) {
  let lastShift = -Infinity;

  return function keyCommand(e: KeyboardEvent, ctx: KeyContext): AppCommand | null {
    if (e.isComposing || e.repeat) return null;
    const target = e.target;

    const zoom = zoomChord(e);

    if (ctx.lightboxOpen) {
      lastShift = -Infinity;
      if (e.metaKey || e.ctrlKey || e.altKey) return zoom ? { id: zoom } : null;
      if (e.key === "Escape") return { id: "lightbox_close" };
      if (e.key === "ArrowLeft") return { id: "lightbox_prev" };
      if (e.key === "ArrowRight") return { id: "lightbox_next" };
      return null;
    }

    // Double Shift: two bare Shift presses with nothing between them.
    if (e.key === "Shift") {
      if (e.metaKey || e.ctrlKey || e.altKey) {
        lastShift = -Infinity;
        return null;
      }
      const t = now();
      const doubled = t - lastShift < DOUBLE_SHIFT_MS;
      lastShift = doubled ? -Infinity : t;
      if (!doubled) return null;
      if (within(target, DIALOG) || within(target, TERMINAL) || within(target, CODEMIRROR)) {
        return null;
      }
      return { id: "go_to_file" };
    }
    lastShift = -Infinity;

    if (within(target, DIALOG)) {
      if (zoom) return { id: zoom };
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        return { id: "save_all" };
      }
      return null;
    }

    if (insideMonaco(target) && monacoOwns(e)) return null;

    const inTerminal = within(target, TERMINAL);
    if (inTerminal && e.ctrlKey && !e.metaKey && isMac()) return null;

    const tab = tabCommand(e);
    if (tab) {
      if (inTerminal && e.ctrlKey && !e.metaKey) return null;
      if ((tab === "split-right" || tab === "split-down") && within(target, CODEMIRROR)) {
        return null;
      }
      if (typeof tab === "object" && "activate" in tab && within(target, PICKER)) return null;
      if (tab === "toggle-terminal" && ctx.terminalToggle === false) return null;
      return fromTabCommand(tab);
    }

    if (zoom) return { id: zoom };

    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return null;
    const key = e.key.toLowerCase();

    if (e.altKey && !e.shiftKey && e.code === "KeyZ") return { id: "toggle_zen" };
    if (e.altKey) return null;

    if (e.shiftKey) {
      if (key === "f") return { id: "find_in_project" };
      if (key === "n") return { id: "new_window" };
      return null;
    }

    switch (key) {
      case "b":
        return { id: "toggle_sidebar" };
      case "p":
        return { id: "go_to_file" };
      case "o":
        return { id: "go_to_symbol" };
      case "t":
        return { id: "show_hierarchy" };
      case "s":
        return { id: "save_all" };
      case "k":
        return { id: "open_search" };
      case ",":
        return { id: "open_settings" };
      default:
        return null;
    }
  };
}

/** The menu route's overlay guard, mirroring the DOM one. */
export function menuCommandAllowed(
  id: AppCommandId,
  ctx: { dialogOpen: boolean; lightboxOpen: boolean },
): boolean {
  if (ctx.dialogOpen || ctx.lightboxOpen) return DIALOG_SAFE.has(id);
  return true;
}

export function dialogOpen(doc: Pick<Document, "querySelector"> = document): boolean {
  return !!doc.querySelector(DIALOG);
}
