import type { HtmlRenderReference } from "@shared/htmlRender";

/**
 * The HTML page viewer's module store, apart from the viewer
 * (HtmlRenderViewer.tsx, in the html-render chunk) so the command map and
 * a row's expand button can open and close it without pulling the Dialog
 * primitive into the first paint.
 */

export type HtmlRenderOverlayState = { reference: HtmlRenderReference; host?: string };

let current: HtmlRenderOverlayState | null = null;
const subs = new Set<() => void>();
const emit = (): void => subs.forEach((f) => f());

export function subscribeHtmlRenderOverlay(f: () => void): () => void {
  subs.add(f);
  return () => subs.delete(f);
}

export function htmlRenderOverlaySnapshot(): HtmlRenderOverlayState | null {
  return current;
}

export function openHtmlRenderOverlay(reference: HtmlRenderReference, host?: string): void {
  current = { reference, host };
  emit();
}

export function closeHtmlRenderOverlay(): void {
  if (!current) return;
  current = null;
  emit();
}

/** The command map treats an open page like an open lightbox (Escape closes it). */
export function isHtmlRenderOverlayOpen(): boolean {
  return current !== null;
}
