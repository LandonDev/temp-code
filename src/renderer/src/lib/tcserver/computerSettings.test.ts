import { describe, expect, it } from "vitest";
import type { ComputerAppVerdict } from "@server/shared/contract-computer";
import type { Link } from "../connection/link";
import type { ServerPush } from "@server/shared/contract";
import {
  appTitle,
  forgetComputerApps,
  idleMinutes,
  idleMs,
  missingGrant,
  onComputerSettings,
  readComputerPermissions,
  readComputerSettings,
  retryComputerService,
  setComputerSettings,
  sortApps,
} from "./computerSettings";

function fakeLink() {
  const calls: [string, unknown][] = [];
  const listeners = new Set<(p: ServerPush) => void>();
  const link = {
    environmentId: "local",
    connected: true,
    profile: "local",
    request: async (method: string, params: unknown) => {
      calls.push([method, params]);
      return null;
    },
    onPush: (fn: (p: ServerPush) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onOpen: () => () => {},
    onClose: () => () => {},
  } as unknown as Link;
  return { link, calls, push: (p: unknown) => listeners.forEach((fn) => fn(p as ServerPush)) };
}

const app = (bundleId: string, name: string | null, classes: ComputerAppVerdict["classes"] = {}): ComputerAppVerdict => ({ bundleId, name, classes, updatedAt: 1 });

describe("the computer settings wire", () => {
  it("asks each method with its params", async () => {
    const { link, calls } = fakeLink();
    await readComputerSettings(link);
    await setComputerSettings(link, { sessionIdleMs: 300_000 });
    await forgetComputerApps(link, "com.apple.TextEdit");
    await forgetComputerApps(link, null);
    await readComputerPermissions(link);
    await retryComputerService(link);
    expect(calls).toEqual([
      ["computer.settings.get", {}],
      ["computer.settings.set", { sessionIdleMs: 300_000 }],
      ["computer.verdicts.forget", { bundleId: "com.apple.TextEdit" }],
      ["computer.verdicts.forget", { bundleId: null }],
      ["computer.permissions", {}],
      ["computer.service.retry", {}],
    ]);
  });

  it("hears only the computer-settings push, until it lets go", () => {
    const { link, push } = fakeLink();
    const heard: unknown[] = [];
    const off = onComputerSettings(link, (s) => heard.push(s));
    push({ push: "computer", service: {}, sessions: [] });
    push({ push: "computer-settings", settings: { sessionIdleMs: 60_000, apps: [] } });
    off();
    push({ push: "computer-settings", settings: { sessionIdleMs: 120_000, apps: [] } });
    expect(heard).toEqual([{ sessionIdleMs: 60_000, apps: [] }]);
  });
});

describe("the threshold in minutes", () => {
  it("shows whole minutes, at least one, and commits milliseconds", () => {
    expect(idleMinutes(120_000)).toBe(2);
    expect(idleMinutes(150_000)).toBe(3);
    expect(idleMinutes(5_000)).toBe(1);
    expect(idleMinutes(3_600_000)).toBe(60);
    expect(idleMs(7)).toBe(420_000);
  });
});

describe("the learned apps", () => {
  it("puts apps that may take the screen first, then sorts by name, a bundle id standing for no name", () => {
    const sorted = sortApps([app("com.z", "Zed"), app("com.b", null), app("com.a", "Alpha"), app("com.t", "TextEdit", { type: "session" }), app("com.c", "Chrome", { click: "session" })]);
    expect(sorted.map(appTitle)).toEqual(["Chrome", "TextEdit", "Alpha", "com.b", "Zed"]);
  });
});

describe("missingGrant", () => {
  it("is true only for a known grant that is off", () => {
    expect(missingGrant(undefined)).toBe(false);
    expect(missingGrant(null)).toBe(false);
    expect(missingGrant({ accessibility: true, screenRecording: true })).toBe(false);
    expect(missingGrant({ accessibility: false, screenRecording: true })).toBe(true);
    expect(missingGrant({ accessibility: true, screenRecording: false })).toBe(true);
  });
});
