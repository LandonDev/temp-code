import { createContext, useContext } from "react";

/**
 * Whether the pane a subtree belongs to is the one on screen. PaneTree
 * provides it: true for the shown tab, false for a warm (mounted but
 * parked) one. Outside any pane — sidebar, tab strip, dialogs — the
 * default true applies.
 *
 * Every timer and animation-frame loop inside a pane reads this instead of
 * `document.hidden`: a parked pane is not hidden from the browser, so a
 * loop gated only on the document keeps running under the visible tab.
 */
export const PaneVisibilityContext = createContext(true);

export function usePaneVisible(): boolean {
  return useContext(PaneVisibilityContext);
}

/**
 * The rule the loops share: a frame or tick may be scheduled only while
 * the pane is shown and the document is visible. Pure, so it is testable
 * without a DOM.
 */
export function frameLoopAllowed(paneVisible: boolean, documentHidden: boolean): boolean {
  return paneVisible && !documentHidden;
}
