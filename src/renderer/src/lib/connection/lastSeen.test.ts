import { afterEach, describe, expect, it, vi } from "vitest";
import { IDLE_STATUS, type EnvironmentStatus } from "./types";

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
});

const { lastSeenAt, noteSeen, resetLastSeen, trackLastSeen } = await import("./lastSeen");

function fakeRegistry() {
  const statuses = new Map<string, EnvironmentStatus>();
  const listeners = new Set<() => void>();
  return {
    statuses: () => statuses,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set(id: string, transport: EnvironmentStatus["transport"]) {
      statuses.set(id, { ...IDLE_STATUS, transport });
      for (const l of listeners) l();
    },
  };
}

afterEach(() => {
  resetLastSeen();
  storage.clear();
});

describe("last seen", () => {
  it("notes an environment when its session opens and again when it closes", () => {
    const reg = fakeRegistry();
    let t = 1000;
    const off = trackLastSeen(reg, () => t);
    expect(lastSeenAt("box")).toBeNull();
    reg.set("box", "connecting");
    expect(lastSeenAt("box")).toBeNull();
    reg.set("box", "open");
    expect(lastSeenAt("box")).toBe(1000);
    t = 5000;
    reg.set("box", "reconnecting");
    expect(lastSeenAt("box")).toBe(5000);
    t = 9000;
    reg.set("box", "reconnecting");
    expect(lastSeenAt("box")).toBe(5000);
    off();
  });
  it("writes what it noted to storage so a restart still knows", () => {
    noteSeen("mini", 42);
    expect(lastSeenAt("mini")).toBe(42);
    expect(JSON.parse(storage.get("monocode.environments.lastSeen") ?? "{}")).toEqual({ mini: 42 });
  });
});
