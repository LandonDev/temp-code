import { afterEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
});

const { environment, environmentAt, environmentStore, stepEnvironment } = await import("./environment");

afterEach(() => {
  environment.reset();
  storage.clear();
});

describe("environment store", () => {
  it("follows the environment on screen and remembers the workspace per environment", () => {
    environment.follow("box", "/srv/agents/work/app");
    expect(environmentStore.getState()).toEqual({ currentId: "box", lastWorkspace: { box: "/srv/agents/work/app" } });
    environment.follow("local", "/Users/me/app");
    environment.follow("box");
    expect(environmentStore.getState().currentId).toBe("box");
    expect(environmentStore.getState().lastWorkspace).toEqual({ box: "/srv/agents/work/app", local: "/Users/me/app" });
    expect(storage.get("monocode.environment.current.test")).toBe("box");
    expect(JSON.parse(storage.get("monocode.environment.lastWorkspace") ?? "{}")).toEqual({ box: "/srv/agents/work/app", local: "/Users/me/app" });
  });
  it("returns the same state object for a repeated follow", () => {
    environment.follow("box", "/a");
    const before = environmentStore.getState();
    environment.follow("box", "/a");
    expect(environmentStore.getState()).toBe(before);
  });
  it("forgetting the current environment falls back to this machine", () => {
    environment.follow("box", "/a");
    environment.forget("box");
    expect(environmentStore.getState()).toEqual({ currentId: "local", lastWorkspace: {} });
  });
  it("steps and indexes with wraparound", () => {
    const ids = ["local", "box", "mini"];
    expect(stepEnvironment(ids, "local", 1)).toBe("box");
    expect(stepEnvironment(ids, "mini", 1)).toBe("local");
    expect(stepEnvironment(ids, "local", -1)).toBe("mini");
    expect(stepEnvironment(ids, "gone", 1)).toBe("local");
    expect(stepEnvironment([], "local", 1)).toBe("local");
    expect(environmentAt(ids, 1)).toBe("box");
    expect(environmentAt(ids, -1)).toBe("mini");
    expect(environmentAt(ids, 7)).toBeNull();
  });
});
