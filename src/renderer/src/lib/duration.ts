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

/** An age in whole minutes, "<1m", "12m", "2h 14m": for text a half-minute
 *  clock refreshes (useSlowClock), which would jump a second hand 30s at a time. */
export function minuteAge(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

const clocks = new Map<string, Intl.DateTimeFormat>();

/** The app's one clock time, "2:02 PM" (12-hour with AM/PM where the
 *  locale writes it so, "14:02" where it does not); `locale` for a test. */
export function clockTime(ts: number, locale?: string): string {
  const key = locale ?? "";
  let clock = clocks.get(key);
  if (!clock) {
    clock = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" });
    clocks.set(key, clock);
  }
  return clock.format(ts);
}

/** Epoch ms on the shared second hand while `active` and the pane is on screen; a still 0 otherwise. */
export function useNow(active: boolean): number {
  // Both hooks run every render: `active &&` would skip the second one.
  const visible = usePaneVisible();
  return useClock(active && visible);
}
