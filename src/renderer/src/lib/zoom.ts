import { invoke } from "./native";

/**
 * Webview zoom level, shared by every window and kept across relaunches.
 * The View menu steps it; each window applies the saved level on boot.
 */

const KEY = "monocode.zoom";
const STEP = 0.1;
const MIN = 0.5;
const MAX = 2;

export function clampZoom(level: number): number {
  const rounded = Math.round(level * 10) / 10;
  return Math.min(MAX, Math.max(MIN, rounded));
}

export function loadZoom(): number {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw == null ? NaN : Number(raw);
    return Number.isFinite(parsed) ? clampZoom(parsed) : 1;
  } catch {
    return 1;
  }
}

function saveZoom(level: number): void {
  try {
    localStorage.setItem(KEY, String(level));
  } catch {
    // private mode / quota
  }
}

export function stepZoom(level: number, direction: 1 | -1): number {
  return clampZoom(level + direction * STEP);
}

/** Zoom this window's webview and remember the level. */
export async function applyZoom(level: number): Promise<number> {
  const next = clampZoom(level);
  saveZoom(next);
  await invoke("set_zoom", { level: next });
  return next;
}

export function zoomIn(): Promise<number> {
  return applyZoom(stepZoom(loadZoom(), 1));
}

export function zoomOut(): Promise<number> {
  return applyZoom(stepZoom(loadZoom(), -1));
}

export function zoomReset(): Promise<number> {
  return applyZoom(1);
}
