import { useEffect, useState } from "react";
import type { ProfileView, UsageReport, UsageWindow } from "aliax-core/shared/types";
import { cycleMs, healthOf, onPaceLeft, percentLeft, type Health } from "aliax-core/shared/health";

export { cycleMs, healthOf, onPaceLeft, percentLeft, type Health };

export const displayName = (p: ProfileView): string => p.nickname ?? p.email ?? p.name;

const TONE: Record<Health, string> = {
  good: "text-success",
  warning: "text-warning",
  critical: "text-danger",
};
const FILL: Record<Health, string> = {
  good: "bg-success",
  warning: "bg-warning",
  critical: "bg-danger",
};

export const toneFor = (w: UsageWindow, now: number): string => TONE[healthOf(w, now)];
export const fillFor = (w: UsageWindow, now: number): string => FILL[healthOf(w, now)];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Compact time until refill: "2h 14m", "3d 4h", "under a minute". */
export function untilLabel(resetsAt: number, now: number): string {
  const ms = resetsAt - now;
  if (ms < 60_000) return "under a minute";
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / 60_000);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** The refill moment in full: "Wed 5:30 PM". */
export const resetLabel = (at: number): string =>
  new Date(at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

/** The reset moment, as short as the distance allows: "5:30 PM", "Wed 5:30 PM", "Aug 22". */
export function resetPoint(at: number, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (at - now < DAY) return time;
  if (at - now < 7 * DAY) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The report of one profile, if it has one. */
export const reportOf = (reports: UsageReport[], name: string | null): UsageReport | undefined =>
  name === null ? undefined : reports.find((r) => r.profileName === name);

/** A window's label as the footer shows it: "5h", "Weekly", "Fable", … */
export const windowLabel = (label: string): string =>
  /^5\s*h/i.test(label) ? "5h" : /week/i.test(label) ? "Weekly" : label;

/**
 * How many OTHER signed-in profiles of a provider still have room in the
 * window with this label: neither at 100% nor expired, and not the one shown.
 */
export function othersWithRoom(reports: UsageReport[], except: string | null, label: string): number {
  let n = 0;
  for (const r of reports) {
    if (r.profileName === except || r.expired) continue;
    const w = r.windows.find((x) => x.label === label);
    if (w && w.usedPercent < 100) n += 1;
  }
  return n;
}

/** The current time, refreshed on an interval, so countdowns stay honest. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
