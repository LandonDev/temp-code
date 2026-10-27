/**
 * One z-index scale for everything that floats over the app chrome, the
 * same numbers as the `--layer-*` tokens in index.css. Panels and buttons
 * inside a surface stay below 50. Menus sit above dialogs, so a menu opened
 * from inside a dialog lands over it.
 */
export const LAYER = {
  /** Modal dialogs and the command palette. */
  dialog: 90,
  /** Anchored menus, dropdowns, and pickers. */
  popover: 95,
  /** A flyout hung off an open popover. */
  submenu: 96,
  /** Toasts, which outrank whatever they interrupt. */
  toast: 100,
} as const;
