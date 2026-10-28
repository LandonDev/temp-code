// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PLAN_SETTINGS } from "@shared/plans";
import { EnvLink } from "../connection/link";
import { ConnectionLostError, type Transport } from "../connection/transport";
import { LOAD_DEADLINE_MS, NO_ANSWER } from "../connection/openRead";

/** A socket the test answers by hand; the link only sees its surface. */
class Scripted {
  state: "open" | "closed" = "open";
  profile = "local" as const;
  calls: { method: string; params: unknown; resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];
  private closes = new Set<() => void>();
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.state !== "open") return Promise.reject(new ConnectionLostError("not connected"));
    return new Promise((resolve, reject) => this.calls.push({ method, params, resolve, reject }));
  }
  onPush(): () => void {
    return () => undefined;
  }
  onAnswer(): () => void {
    return () => undefined;
  }
  onClose(l: () => void): () => void {
    this.closes.add(l);
    return () => this.closes.delete(l);
  }
  drop(): void {
    this.state = "closed";
    for (const c of this.calls) c.reject(new ConnectionLostError("connection closed"));
    this.calls = [];
    for (const l of this.closes) l();
  }
  asTransport(): Transport {
    return this as unknown as Transport;
  }
}

const host = vi.hoisted(() => ({ link: null as unknown as EnvLink }));
vi.mock("../connection", () => ({ registry: { linkOf: () => host.link } }));
vi.mock("../macBridge", () => ({ bridgeNewThread: async () => {} }));
vi.mock("./store", () => ({ sessionStore: { adopt: () => {} } }));

const { loadPlanSettings, resetPlanSettingsForTests, usePlanSettings, usePlanSettingsError } = await import("./plans");

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const answer = { settings: { ...DEFAULT_PLAN_SETTINGS, autoImplement: false }, overridden: true };

const useScope = () => ({ scope: usePlanSettings("local", null), failure: usePlanSettingsError("local", null) });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  host.link = new EnvLink("local", "local");
  resetPlanSettingsForTests();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("plan settings after a reload", () => {
  it("waits for the socket and resolves within one answer of its open", async () => {
    const { result } = renderHook(useScope);
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(result.current.scope).toBeUndefined();
    expect(result.current.failure).toBeNull();

    const socket = new Scripted();
    await act(async () => {
      host.link.setSession(socket.asTransport());
      await settle();
    });
    expect(socket.calls.map((c) => c.method)).toEqual(["plans.get"]);
    await act(async () => {
      socket.calls[0].resolve(answer);
      await settle();
    });
    expect(result.current.scope).toEqual(answer);
  });

  it("shows the error with Retry at the deadline when the socket never opens, and Retry loads", async () => {
    const { result } = renderHook(useScope);
    await act(() => vi.advanceTimersByTimeAsync(LOAD_DEADLINE_MS));
    expect(result.current.scope).toBeUndefined();
    expect(result.current.failure?.error).toBe(NO_ANSWER);

    const socket = new Scripted();
    await act(async () => {
      host.link.setSession(socket.asTransport());
      await settle();
    });
    act(() => result.current.failure?.retry());
    await act(settle);
    expect(result.current.failure).toBeNull();
    const asks = socket.calls.filter((c) => c.method === "plans.get");
    expect(asks.length).toBeGreaterThan(0);
    await act(async () => {
      for (const c of asks) c.resolve(answer);
      await settle();
    });
    expect(result.current.scope).toEqual(answer);
    expect(result.current.failure).toBeNull();
  });

  it("says so at the deadline when an open socket never answers, and the late answer still lands", async () => {
    const socket = new Scripted();
    host.link.setSession(socket.asTransport());
    const { result } = renderHook(useScope);
    await act(settle);
    expect(socket.calls).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(LOAD_DEADLINE_MS));
    expect(result.current.failure?.error).toBe(NO_ANSWER);
    await act(async () => {
      socket.calls[0].resolve(answer);
      await settle();
    });
    expect(result.current.scope).toEqual(answer);
    expect(result.current.failure).toBeNull();
  });

  it("asks again on the socket that replaces one dropped mid-load", async () => {
    const first = new Scripted();
    host.link.setSession(first.asTransport());
    const { result } = renderHook(useScope);
    await act(settle);
    expect(first.calls).toHaveLength(1);
    const second = new Scripted();
    await act(async () => {
      first.drop();
      await settle();
      host.link.setSession(second.asTransport());
      await settle();
    });
    expect(second.calls.map((c) => c.method)).toEqual(["plans.get"]);
    await act(async () => {
      second.calls[0].resolve(answer);
      await settle();
    });
    expect(result.current.scope).toEqual(answer);
  });

  it("re-asks a scope that failed when a new socket opens", async () => {
    const first = new Scripted();
    host.link.setSession(first.asTransport());
    const { result } = renderHook(useScope);
    await act(settle);
    await act(async () => {
      first.calls[0].reject(new Error("unknown method"));
      await settle();
    });
    expect(result.current.failure?.error).toBe("unknown method");
    const second = new Scripted();
    await act(async () => {
      host.link.setSession(second.asTransport());
      await settle();
    });
    expect(second.calls.map((c) => c.method)).toEqual(["plans.get"]);
  });
});

describe("plan settings store", () => {
  it("shares one request between callers while it is in flight", async () => {
    const socket = new Scripted();
    host.link.setSession(socket.asTransport());
    const a = loadPlanSettings("local", "p1");
    const b = loadPlanSettings("local", "p1");
    await settle();
    expect(socket.calls).toHaveLength(1);
    socket.calls[0].resolve({ settings: DEFAULT_PLAN_SETTINGS, overridden: false });
    expect(await a).toEqual(await b);
  });
});
