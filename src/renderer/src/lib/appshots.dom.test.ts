// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPSHOT_SETTINGS } from "@shared/appshots";

type Call = { method: string; params: unknown; options: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const link = vi.hoisted(() => ({ calls: [] as Call[] }));
vi.mock("./connection", () => ({
  registry: {
    primary: () => ({
      environmentId: "local",
      request: (method: string, params: unknown, options: unknown) =>
        new Promise((resolve, reject) => link.calls.push({ method, params, options, resolve, reject })),
    }),
  },
}));
vi.mock("./native", () => ({ appshots: { onCapture: () => () => {}, onError: () => () => {}, permissions: async () => ({}) } }));
vi.mock("./monaco/debugTab", () => ({ OPEN_SETTINGS_EVENT: "open-settings" }));
vi.mock("./recents", () => ({ lastProjectPath: () => null }));
vi.mock("./tcserver/projects", () => ({ projectForCwd: () => undefined }));
vi.mock("./tcserver/store", () => ({ sessionStore: { metas: () => [] } }));
vi.mock("./tcserver/workspaces", () => ({ workspaceStore: { projects: [] } }));
vi.mock("../assets/shutter.wav?url", () => ({ default: "" }));

const store = await import("./appshots");
const settingsNow = () => renderHook(() => store.useAppshotSettings()).result.current;
const statusNow = () => renderHook(() => store.useAppshotSettingsStatus()).result.current;

const flush = () => new Promise((r) => setTimeout(r, 0));
const stored = { enabled: true, destination: "new-chat" as const, sound: false };

beforeEach(() => {
  link.calls = [];
  store.resetAppshotSettingsForTests();
});

describe("appshot settings", () => {
  it("asks with the link's retry and lands the stored set once the host answers", async () => {
    const load = store.loadAppshotSettings();
    expect(link.calls[0]).toMatchObject({ method: "appshots.get", options: { retry: true } });
    link.calls[0].resolve(stored);
    await load;
    expect(settingsNow()).toEqual(stored);
    expect(statusNow().loaded).toBe(true);
  });

  it("sends nothing before the load answered, so defaults never overwrite the stored set", () => {
    store.setAppshotSettings({ sound: true });
    expect(link.calls).toHaveLength(0);
    expect(settingsNow()).toEqual(DEFAULT_APPSHOT_SETTINGS);
  });

  it("writes the patch over the loaded set, and puts it back when the write fails", async () => {
    const load = store.loadAppshotSettings();
    link.calls[0].resolve(stored);
    await load;
    store.setAppshotSettings({ sound: true });
    await flush();
    expect(link.calls[1]).toMatchObject({ method: "appshots.set", params: { settings: { ...stored, sound: true } } });
    link.calls[1].reject(new Error("host refused"));
    await flush();
    expect(settingsNow()).toEqual(stored);
    expect(statusNow().writeError).toEqual({ key: "sound", message: "host refused" });
  });

  it("puts two overlapping failed writes back to what the host stored", async () => {
    const load = store.loadAppshotSettings();
    link.calls[0].resolve(stored);
    await load;
    store.setAppshotSettings({ sound: true });
    store.setAppshotSettings({ sound: false });
    await flush();
    link.calls[1].reject(new Error("down"));
    await flush();
    link.calls[2].reject(new Error("down"));
    await flush();
    expect(settingsNow().sound).toBe(false);
  });

  it("sends a later write after a failed one put its change back, so the host and the page agree", async () => {
    const load = store.loadAppshotSettings();
    link.calls[0].resolve(stored);
    await load;
    store.setAppshotSettings({ sound: true });
    store.setAppshotSettings({ destination: "automatic" });
    await flush();
    // One write at a time: the second waits for the first's answer.
    expect(link.calls).toHaveLength(2);
    link.calls[1].reject(new Error("down"));
    await flush();
    expect(link.calls[2].params).toEqual({ settings: { ...stored, sound: false, destination: "automatic" } });
    link.calls[2].resolve({});
    await flush();
    expect(settingsNow()).toEqual({ ...stored, sound: false, destination: "automatic" });
  });

  it("keeps a failed load's reason", async () => {
    const load = store.loadAppshotSettings();
    link.calls[0].reject(new Error("not connected"));
    await load;
    expect(statusNow()).toMatchObject({ loaded: false, loadError: "not connected" });
  });
});
