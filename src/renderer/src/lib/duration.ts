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

/** A task's or a step's time shows once it says something: under this it
 *  is noise ("0s" for a step that was skipped at once). */
export const TIME_SHOWN_FROM_MS = 1500;

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

const days = new Map<string, Intl.DateTimeFormat>();

/** A clock time that names its day when that is not today: "2:02 PM" today, "Mon 2:02 PM" within the last six
 *  days, "Nov 3, 2:02 PM" before that. `now` and `locale` for a test. */
export function dayTime(ts: number, now = Date.now(), locale?: string): string {
  const day = (t: number): number => new Date(t).setHours(0, 0, 0, 0);
  const ago = Math.round((day(now) - day(ts)) / 86_400_000);
  if (ago === 0) return clockTime(ts, locale);
  const near = ago > 0 && ago < 7;
  const key = `${locale ?? ""}:${near}`;
  let fmt = days.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, near ? { weekday: "short" } : { month: "short", day: "numeric" });
    days.set(key, fmt);
  }
  return near ? `${fmt.format(ts)} ${clockTime(ts, locale)}` : `${fmt.format(ts)}, ${clockTime(ts, locale)}`;
}

/** Epoch ms on the shared second hand while `active` and the pane is on screen; a still 0 otherwise. */
export function useNow(active: boolean): number {
  // Both hooks run every render: `active &&` would skip the second one.
  const visible = usePaneVisible();
  return useClock(active && visible);
}
