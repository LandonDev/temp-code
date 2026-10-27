// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PLAN_SETTINGS } from "@shared/plans";

type Call = { method: string; params: unknown; options: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const link = vi.hoisted(() => ({ calls: [] as Call[] }));
vi.mock("../connection", () => ({
  registry: {
    linkOf: () => ({
      request: (method: string, params: unknown, options: unknown) =>
        new Promise((resolve, reject) => link.calls.push({ method, params, options, resolve, reject })),
    }),
  },
}));
vi.mock("../macBridge", () => ({ bridgeNewThread: async () => {} }));
vi.mock("./store", () => ({ sessionStore: { adopt: () => {} } }));

const { loadPlanSettings, resetPlanSettingsForTests, usePlanSettings, usePlanSettingsError } = await import("./plans");

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  link.calls = [];
  resetPlanSettingsForTests();
});
afterEach(cleanup);

describe("plan settings store", () => {
  it("asks with the link's retry, so a read made before the socket opens lands once it does", async () => {
    const load = loadPlanSettings("local", null);
    expect(link.calls).toHaveLength(1);
    expect(link.calls[0]).toMatchObject({ method: "plans.get", params: { projectId: null }, options: { retry: true } });
    link.calls[0].resolve({ settings: { ...DEFAULT_PLAN_SETTINGS, autoImplement: false }, overridden: true });
    await expect(load).resolves.toMatchObject({ overridden: true, settings: { autoImplement: false } });
  });

  it("shares one request between callers while it is in flight", async () => {
    const a = loadPlanSettings("local", "p1");
    const b = loadPlanSettings("local", "p1");
    expect(link.calls).toHaveLength(1);
    link.calls[0].resolve({ settings: DEFAULT_PLAN_SETTINGS, overridden: false });
    expect(await a).toBe(await b);
  });

  it("keeps a final failure as the scope's error, and Retry loads it", async () => {
    const { result } = renderHook(() => ({
      scope: usePlanSettings("local", null),
      failure: usePlanSettingsError("local", null),
    }));
    expect(link.calls).toHaveLength(1);
    await act(async () => {
      link.calls[0].reject(new Error("not connected"));
      await flush();
    });
    expect(result.current.scope).toBeUndefined();
    expect(result.current.failure?.error).toBe("not connected");
    // A failed load is not asked again on its own.
    expect(link.calls).toHaveLength(1);

    act(() => result.current.failure?.retry());
    expect(result.current.failure).toBeNull();
    expect(link.calls).toHaveLength(2);
    await act(async () => {
      link.calls[1].resolve({ settings: DEFAULT_PLAN_SETTINGS, overridden: false });
      await flush();
    });
    expect(result.current.scope).toEqual({ settings: DEFAULT_PLAN_SETTINGS, overridden: false });
  });
});
