import type { MintState } from "@shared/accounts";
import type { ProfileView, UsageReport } from "aliax-core/shared/types";

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

function rateDetail(rl: NonNullable<UsageReport["rateLimit"]>, now: number): string | undefined {
  if (rl.until === undefined) return undefined;
  const ms = rl.until - now;
  if (ms <= 0) return "retrying";
  const mins = Math.ceil(ms / 60_000);
  return `${mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`} left`;
}

/** A row's state line, first match wins; null when there is nothing to say. */
export function rowLine(profile: ProfileView, report: UsageReport | undefined, owner: OwnerView | null, mint: MintState | undefined, now: number): RowLine | null {
  const lapsed = report?.expired === true || (profile.expiresAt !== undefined && profile.expiresAt <= now);
  const token: RowAction = { label: "Make a new one", kind: "token" };

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
  if (report?.rateLimit && !report.expired) return { text: "Rate limited", tone: "warning", detail: rateDetail(report.rateLimit, now) };
  if (profile.static) {
    return { text: "One-year token", tone: "muted", detail: profile.expiresAt !== undefined ? `lapses ${shortDay(profile.expiresAt)}` : undefined };
  }
  if (owner) {
    return { text: `Refreshed by ${owner.name}`, tone: "muted", detail: profile.syncedAt !== undefined ? `synced ${agoLabel(profile.syncedAt, now)}` : undefined };
  }
  return null;
}
