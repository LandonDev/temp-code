import type { AccountHeadroom, MintState } from "@shared/accounts";
import type { ProfileView, UsageReport, UsageWindow } from "aliax-core/shared/types";
import { percentLeft } from "@aliax/lib/accounts";
import { clockTime } from "@renderer/lib/duration";

/** The host that refreshes an account, as a row sees it. */
export interface OwnerView {
  name: string;
  connected: boolean;
}

export type RowAction = { label: string; kind: "token" | "sync" | "reauth" };

/**
 * The one state line under an account's name: where its sign-in lives, what
 * is wrong with it, and the one thing to do about it. `detail` is a second
 * fact after the text; `busy` puts a spinner before it.
 */
export interface RowLine {
  text: string;
  tone: "muted" | "warning";
  detail?: string;
  action?: RowAction;
  busy?: boolean;
  /** The account is out of room: the line is the Limited mark, with when it lifts when anything says. */
  limited?: { resetsAt: number | null };
}

const DAY_MS = 86_400_000;
/** The last 30 days of a one-year token: time to make a new one. */
export const STATIC_WARN_MS = 30 * DAY_MS;

const daysUntil = (t: number, now: number): number => Math.ceil((t - now) / DAY_MS);
export const shortDay = (t: number): string => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export function agoLabel(t: number, now: number): string {
  const mins = Math.max(0, Math.round((now - t) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

const dayClocks = new Map<string, Intl.DateTimeFormat>();

/** A clock time past today: the weekday within six days ("Thu 9:00 AM"),
 *  the date from a week out ("Nov 12, 9:00 AM"), so a weekday never names
 *  today's. The day is the local calendar's; `locale` for a test. */
export function dayClockTime(ts: number, now: number, locale?: string): string {
  const days = Math.round((startOfDay(ts) - startOfDay(now)) / 86_400_000);
  const shape = days >= 7 ? "date" : "weekday";
  const key = `${shape}|${locale ?? ""}`;
  let clock = dayClocks.get(key);
  if (!clock) {
    clock = new Intl.DateTimeFormat(locale, shape === "date" ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
    dayClocks.set(key, clock);
  }
  return clock.format(ts);
}

/** Whether two moments fall on one local calendar day. */
const sameDay = (a: number, b: number): boolean => startOfDay(a) === startOfDay(b);

function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * When a window refills, as the row says it: "Resets 4:15 PM" inside today,
 * "Resets Thu 9:00 AM" past it (the date from a week out). `locale` for a test.
 */
export function resetWords(resetsAt: number, now: number, locale?: string): string {
  return `Resets ${sameDay(resetsAt, now) ? clockTime(resetsAt, locale) : dayClockTime(resetsAt, now, locale)}`;
}

/** A window that has a reset still ahead of it; one whose reset passed is stale, as the meter reads it. */
const liveWindow = (w: UsageWindow, now: number): boolean => w.resetsAt === undefined || w.resetsAt > now;

/**
 * Whether an account is out of room now, and when it lifts: the gateways'
 * cooldown, the provider's own limit, or every usage window spent. The lift
 * is the latest of what binds it, or null when any of them names no time:
 * the row then says Limited alone, never a guess.
 */
export function limitOf(report: UsageReport | undefined, headroom: AccountHeadroom | undefined, now: number): { resetsAt: number | null } | null {
  if (report?.expired) return null;
  const binding: (number | null)[] = [];
  if (headroom?.throttledUntil !== undefined && headroom.throttledUntil > now) binding.push(headroom.throttledUntil);
  const limit = report?.rateLimit;
  if (limit && (limit.until === undefined || limit.until > now)) binding.push(limit.until ?? null);
  const live = report?.windows.filter((w) => liveWindow(w, now)) ?? [];
  if (live.length > 0 && live.every((w) => percentLeft(w) <= 0)) binding.push(...live.map((w) => w.resetsAt ?? null));
  if (binding.length === 0) return null;
  return { resetsAt: binding.includes(null) ? null : Math.max(...(binding as number[])) };
}

/**
 * A key account's state, for the status column: revoked in amber, else paid
 * per token; null while the probe has not answered (the column's skeleton).
 */
export function keyStatus(report: UsageReport | undefined): { text: string; tone: "muted" | "warning" } | null {
  if (!report) return null;
  if (report.expired || report.note === "key revoked") return { text: "Key revoked", tone: "warning" };
  // Anything else is the probe's own note: "pay as you go", or why it could not answer (a 429, a 5xx).
  const note = report.note ?? "Pay as you go";
  return { text: note.charAt(0).toUpperCase() + note.slice(1), tone: "muted" };
}

/** A row's state line, first match wins; null when there is nothing to say. */
export function rowLine(
  profile: ProfileView,
  report: UsageReport | undefined,
  owner: OwnerView | null,
  mint: MintState | undefined,
  now: number,
  limit: { resetsAt: number | null } | null = limitOf(report, undefined, now),
): RowLine | null {
  const lapsed = report?.expired === true || (profile.expiresAt !== undefined && profile.expiresAt <= now);
  const token: RowAction = { label: "Make a new one", kind: "token" };

  const limited: RowLine | null = limit ? { text: "Limited", tone: "warning", limited: limit } : null;

  // A key never lapses, refreshes or mints: the status column says revoked, and a limit is the only line.
  if (profile.kind === "key") return limited;
  if (mint?.state === "minting") return { text: "Making a one-year token", tone: "muted", busy: true };
  if (mint) {
    const verb = profile.static ? "renew" : "make";
    return mint.state === "needs-sign-in"
      ? { text: `Sign in to ${verb} its one-year token`, tone: "warning", action: { label: "Sign in", kind: "token" } }
      : { text: `Could not ${verb} its one-year token`, tone: "warning", detail: mint.detail, action: { label: "Retry", kind: "token" } };
  }
  if (profile.duplicate) return { text: "Same sign-in as another saved account", tone: "warning" };
  if (report?.expired && !profile.static && !owner) return { text: "Session expired", tone: "warning", action: { label: "Sign in", kind: "reauth" } };
  if (profile.static) {
    if (lapsed) return { text: "One-year token lapsed", tone: "warning", action: token };
    const days = profile.expiresAt !== undefined ? daysUntil(profile.expiresAt, now) : null;
    if (days !== null && days * DAY_MS <= STATIC_WARN_MS) {
      return { text: `One-year token lapses in ${days} day${days === 1 ? "" : "s"}`, tone: "warning", action: token };
    }
  }
  if (owner && lapsed) {
    const retry: RowAction = { label: "Retry", kind: "sync" };
    if (owner.connected) return { text: `Waiting for a fresh token from ${owner.name}`, tone: "warning", action: retry };
    const since = profile.expiresAt !== undefined ? ` ${agoLabel(profile.expiresAt, now)}` : "";
    return { text: `${owner.name} is unreachable, token lapsed${since}`, tone: "warning", action: retry };
  }
  if (limited) return limited;
  if (profile.static) {
    return { text: "One-year token", tone: "muted", detail: profile.expiresAt !== undefined ? `lapses ${shortDay(profile.expiresAt)}` : undefined };
  }
  if (owner) {
    return { text: `Refreshed by ${owner.name}`, tone: "muted", detail: profile.syncedAt !== undefined ? `synced ${agoLabel(profile.syncedAt, now)}` : undefined };
  }
  return null;
}
