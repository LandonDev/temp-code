import { useState, useSyncExternalStore } from "react";
import { htmlRenderChunk } from "./chunks";
import { htmlRenderOverlaySnapshot, subscribeHtmlRenderOverlay } from "./htmlRenderOverlayStore";

export { closeHtmlRenderOverlay, isHtmlRenderOverlayOpen, openHtmlRenderOverlay } from "./htmlRenderOverlayStore";

// The viewer and its Dialog ride the html-render chunk (surfaces/chunks.ts),
// warm by the time a row's expand button is clicked.
const HtmlRenderViewer = htmlRenderChunk.surface("HtmlRenderViewer");

/**
 * App's mount point for the HTML page viewer (HtmlRenderViewer.tsx): nothing
 * until a page first opens, then the viewer, kept mounted so its exit plays.
 */
export function HtmlRenderOverlay() {
  const open = useSyncExternalStore(subscribeHtmlRenderOverlay, () => htmlRenderOverlaySnapshot() !== null);
  const [opened, setOpened] = useState(false);
  if (open && !opened) setOpened(true);
  return opened ? <HtmlRenderViewer /> : null;
}
