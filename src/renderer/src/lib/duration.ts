import { usePaneVisible } from "../hooks/paneVisibility";
import { useClock } from "./turnClock";

/** How long ago and how long, in the app's short form ("now", "5m", "1m 32s"), and the second hand that drives them. */

export function timeAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ""}`;
}

/** Epoch ms on the shared second hand while `active` and the pane is on screen; a still 0 otherwise. */
export function useNow(active: boolean): number {
  // Both hooks run every render: `active &&` would skip the second one.
  const visible = usePaneVisible();
  return useClock(active && visible);
}
