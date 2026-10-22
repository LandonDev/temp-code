import { createContext, useContext } from "react";

/**
 * One z-index scale for everything that floats over the app chrome. Panels and
 * buttons inside a surface stay below 50; anything that escapes its pane —
 * menus, dialogs, toasts — picks a layer from here so the order is decided in
 * one place instead of by whichever stray `z-50` was written last.
 */
export const LAYER = {
  /** Anchored menus, dropdowns, and pickers. */
  popover: 80,
  /** A flyout hung off an open popover. */
  submenu: 81,
  /** Modal dialogs and the command palette. */
  dialog: 90,
  /** Toasts, which outrank whatever they interrupt. */
  toast: 100,
} as const;

/**
 * The layer the surrounding floating surface sits on, or null at the app
 * root. A dialog provides its own; a popover opened from inside it reads
 * the value and lifts itself above (a portal keeps React context, so the
 * menu lands over the sheet, never under it).
 */
export const LayerContext = createContext<number | null>(null);

/** The z-index a floating surface takes: its own layer, lifted above the
 *  surface it opened from by the same distance it keeps at the root. */
export function liftedLayer(layer: number, above: number | null): number {
  return above === null ? layer : Math.max(layer, above + 1 + (layer - LAYER.popover));
}

export function useLiftedLayer(layer: number): number {
  return liftedLayer(layer, useContext(LayerContext));
}
