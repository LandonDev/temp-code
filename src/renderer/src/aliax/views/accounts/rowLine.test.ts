import { describe, expect, it } from "vitest";
import type { ProfileView, UsageReport } from "aliax-core/shared/types";
import { rowLine } from "./rowLine";

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

  it("says a rate limit with the time left, or retrying", () => {
    expect(rowLine(p(), r({ rateLimit: { provider: "claude", until: NOW + 14 * 60_000 } }), null, undefined, NOW)).toEqual({
      text: "Rate limited",
      tone: "warning",
      detail: "14m left",
    });
    expect(rowLine(p(), r({ rateLimit: { provider: "claude", until: NOW - 1 } }), null, undefined, NOW)?.detail).toBe("retrying");
    expect(rowLine(p(), r({ rateLimit: { provider: "claude" } }), null, undefined, NOW)?.detail).toBeUndefined();
  });

  it("puts a rate limit ahead of a healthy token's quiet line", () => {
    expect(rowLine(p({ static: true, expiresAt: NOW + 200 * DAY }), r({ rateLimit: { provider: "claude" } }), null, undefined, NOW)?.text).toBe("Rate limited");
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
