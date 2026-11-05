import { describe, expect, it } from "vitest";
import type { ProfileView, UsageReport } from "aliax-core/shared/types";
import { keyStatus, limitOf, resetWords, rowLine } from "./rowLine";

const NOW = Date.UTC(2026, 9, 27, 12);
const DAY = 86_400_000;
const p = (extra: Partial<ProfileView> = {}): ProfileView => ({ name: "a@x.com", createdAt: 1, active: false, ...extra });
const r = (extra: Partial<UsageReport> = {}): UsageReport => ({ profileName: "a@x.com", windows: [], ...extra });
const box = { name: "box", connected: true };

describe("rowLine", () => {
  it("is null when there is nothing to say", () => {
    expect(rowLine(p(), r(), null, undefined, NOW)).toBeNull();
  });

  it("says a mint is running, with a spinner", () => {
    expect(rowLine(p(), r(), null, { state: "minting", at: NOW }, NOW)).toEqual({ text: "Making a one-year token", tone: "muted", busy: true });
  });

  it("asks for a sign-in to make or renew the token", () => {
    expect(rowLine(p(), r(), null, { state: "needs-sign-in", at: NOW }, NOW)).toMatchObject({
      text: "Sign in to make its one-year token",
      tone: "warning",
      action: { label: "Sign in", kind: "token" },
    });
    expect(rowLine(p({ static: true }), r(), null, { state: "needs-sign-in", at: NOW }, NOW)?.text).toBe("Sign in to renew its one-year token");
  });

  it("names a failed mint with its reason and Retry", () => {
    expect(rowLine(p(), r(), null, { state: "failed", at: NOW, detail: "HTTP 500" }, NOW)).toEqual({
      text: "Could not make its one-year token",
      tone: "warning",
      detail: "HTTP 500",
      action: { label: "Retry", kind: "token" },
    });
  });

  it("puts a mint ahead of a duplicate", () => {
    expect(rowLine(p({ duplicate: true }), r(), null, { state: "minting", at: NOW }, NOW)?.text).toBe("Making a one-year token");
  });

  it("says a duplicate ahead of an expired session", () => {
    expect(rowLine(p({ duplicate: true }), r({ expired: true }), null, undefined, NOW)).toEqual({ text: "Same sign-in as another saved account", tone: "warning" });
  });

  it("offers a sign-in for an expired session of a row this machine refreshes", () => {
    expect(rowLine(p(), r({ expired: true }), null, undefined, NOW)).toEqual({ text: "Session expired", tone: "warning", action: { label: "Sign in", kind: "reauth" } });
  });

  it("says a lapsed one-year token, not an expired session", () => {
    expect(rowLine(p({ static: true, expiresAt: NOW - DAY }), r({ expired: true }), null, undefined, NOW)).toEqual({
      text: "One-year token lapsed",
      tone: "warning",
      action: { label: "Make a new one", kind: "token" },
    });
  });

  it("warns inside a token's last 30 days", () => {
    expect(rowLine(p({ static: true, expiresAt: NOW + 12 * DAY }), r(), null, undefined, NOW)?.text).toBe("One-year token lapses in 12 days");
    expect(rowLine(p({ static: true, expiresAt: NOW + DAY }), r(), null, undefined, NOW)?.text).toBe("One-year token lapses in 1 day");
  });

  it("waits for a fresh token from a connected owner", () => {
    expect(rowLine(p({ owner: "env_box", expiresAt: NOW - 1 }), r(), box, undefined, NOW)).toEqual({
      text: "Waiting for a fresh token from box",
      tone: "warning",
      action: { label: "Retry", kind: "sync" },
    });
  });

  it("says an unreachable owner and how long ago the token lapsed", () => {
    expect(rowLine(p({ owner: "env_box", expiresAt: NOW - 3 * 3_600_000 }), r(), { name: "box", connected: false }, undefined, NOW)?.text).toBe(
      "box is unreachable, token lapsed 3h ago",
    );
  });

  it("puts a lapsed owner copy ahead of a rate limit", () => {
    expect(rowLine(p({ owner: "env_box", expiresAt: NOW - 1 }), r({ rateLimit: { provider: "claude" } }), box, undefined, NOW)?.text).toBe(
      "Waiting for a fresh token from box",
    );
  });

  it("says a rate limit as Limited with when it lifts, and nothing once it passed", () => {
    expect(rowLine(p(), r({ rateLimit: { provider: "claude", until: NOW + 14 * 60_000 } }), null, undefined, NOW)).toEqual({
      text: "Limited",
      tone: "warning",
      limited: { resetsAt: NOW + 14 * 60_000 },
    });
    expect(rowLine(p(), r({ rateLimit: { provider: "claude", until: NOW - 1 } }), null, undefined, NOW)).toBeNull();
    expect(rowLine(p(), r({ rateLimit: { provider: "claude" } }), null, undefined, NOW)?.limited).toEqual({ resetsAt: null });
  });

  it("puts a limit ahead of a healthy token's quiet line", () => {
    expect(rowLine(p({ static: true, expiresAt: NOW + 200 * DAY }), r({ rateLimit: { provider: "claude" } }), null, undefined, NOW)?.text).toBe("Limited");
  });

  it("names a healthy one-year token and when it lapses", () => {
    const line = rowLine(p({ static: true, expiresAt: NOW + 200 * DAY }), r(), null, undefined, NOW);
    expect(line?.text).toBe("One-year token");
    expect(line?.tone).toBe("muted");
    expect(line?.detail).toMatch(/^lapses /);
  });

  it("names the host that refreshes the account and the last sync", () => {
    expect(rowLine(p({ owner: "env_box", syncedAt: NOW - 4 * 60_000 }), r(), box, undefined, NOW)).toEqual({
      text: "Refreshed by box",
      tone: "muted",
      detail: "synced 4m ago",
    });
  });
});

describe("a key account", () => {
  const key = (extra: Partial<ProfileView> = {}) => p({ static: true, kind: "key", ...extra });

  it("has no line while it works, and never reads as a lapsed token", () => {
    expect(rowLine(key(), r({ note: "pay as you go" }), null, undefined, NOW)).toBeNull();
    expect(rowLine(key(), r({ expired: true, note: "key revoked" }), null, undefined, NOW)).toBeNull();
  });

  it("says a throttle as Limited with when it lifts", () => {
    expect(rowLine(key(), r({ rateLimit: { provider: "Meta Model API", until: NOW + 5 * 60_000 } }), null, undefined, NOW)).toEqual({
      text: "Limited",
      tone: "warning",
      limited: { resetsAt: NOW + 5 * 60_000 },
    });
  });

  it("is Pay as you go, Key revoked in amber, or the probe's note", () => {
    expect(keyStatus(undefined)).toBeNull();
    expect(keyStatus(r({ note: "pay as you go" }))).toEqual({ text: "Pay as you go", tone: "muted" });
    expect(keyStatus(r({ expired: true, note: "key revoked" }))).toEqual({ text: "Key revoked", tone: "warning" });
    expect(keyStatus(r({ note: "usage temporarily unavailable" }))).toEqual({ text: "Usage temporarily unavailable", tone: "muted" });
  });
});

describe("resetWords", () => {
  // Local times, so the day boundary is the test machine's own calendar.
  const now = new Date(2026, 10, 5, 10, 0).getTime();
  const plain = (t: number) => resetWords(t, now, "en-US").replace(/\s/g, " ");

  it("says a clock time for a reset inside today", () => {
    expect(plain(new Date(2026, 10, 5, 16, 15).getTime())).toBe("Resets 4:15 PM");
    expect(plain(new Date(2026, 10, 5, 23, 59).getTime())).toBe("Resets 11:59 PM");
  });

  it("names the weekday past today, and the date from a week out", () => {
    expect(plain(new Date(2026, 10, 6, 0, 5).getTime())).toBe("Resets Fri 12:05 AM");
    expect(plain(new Date(2026, 10, 11, 9, 0).getTime())).toBe("Resets Wed 9:00 AM");
    // A week out the weekday would be today's (a Thursday): the date says it.
    expect(plain(new Date(2026, 10, 12, 9, 0).getTime())).toBe("Resets Nov 12, 9:00 AM");
  });

  it("follows a 24-hour locale", () => {
    expect(resetWords(new Date(2026, 10, 5, 16, 15).getTime(), now, "en-GB")).toBe("Resets 16:15");
  });
});

describe("limitOf", () => {
  const HOUR = 3_600_000;
  const w = (label: string, usedPercent: number, resetsAt?: number) => ({ label, usedPercent, resetsAt, periodMs: 5 * HOUR });

  it("is null while any window has room and nothing throttles it", () => {
    expect(limitOf(r({ windows: [w("5h", 100, NOW + HOUR), w("Weekly", 60, NOW + 3 * DAY)] }), undefined, NOW)).toBeNull();
    expect(limitOf(undefined, undefined, NOW)).toBeNull();
  });

  it("lifts at the latest reset once every window is spent", () => {
    expect(limitOf(r({ windows: [w("5h", 100, NOW + HOUR), w("Weekly", 100, NOW + 3 * DAY)] }), undefined, NOW)).toEqual({ resetsAt: NOW + 3 * DAY });
  });

  it("names no time when a binding window names none, and leaves a stale window out", () => {
    expect(limitOf(r({ windows: [w("5h", 100)] }), undefined, NOW)).toEqual({ resetsAt: null });
    expect(limitOf(r({ windows: [w("5h", 100, NOW - 1)] }), undefined, NOW)).toBeNull();
  });

  it("reads the gateways' cooldown, and never an expired account", () => {
    expect(limitOf(r({ windows: [w("5h", 20, NOW + HOUR)] }), { room: 0, throttledUntil: NOW + 60_000, ratePerMin: 1, seenAt: NOW }, NOW)).toEqual({ resetsAt: NOW + 60_000 });
    expect(limitOf(r({ expired: true, rateLimit: { provider: "claude" } }), undefined, NOW)).toBeNull();
  });
});
