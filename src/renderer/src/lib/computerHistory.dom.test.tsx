// @vitest-environment jsdom
/**
 * The history hook hears its own keys alone: a push for another thread's
 * key gives a reader the same object back, so its section renders nothing.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerHistoryCall } from "@server/shared/contract-computer";

type Push = { push: string; key?: string; call?: ComputerHistoryCall };
const links = vi.hoisted(() => ({ listeners: new Set<(link: unknown, event: string) => void>(), local: null as unknown }));
vi.mock("./connection/registry", () => ({
  LOCAL_ENVIRONMENT_ID: "local",
  registry: {
    onLink: (fn: (link: unknown, event: string) => void) => {
      links.listeners.add(fn);
      return () => links.listeners.delete(fn);
    },
    link: () => links.local ?? undefined,
    statusOf: () => ({ lastHello: { environmentId: "env_mac" } }),
  },
}));
vi.mock("./native", () => ({ nativePlatform: () => "darwin" }));
vi.mock("./nativeWeb", () => ({ isWebMode: () => false }));

const H = await import("./computerHistory");

const call = (n: number, over: Partial<ComputerHistoryCall> = {}): ComputerHistoryCall => ({
  n,
  turn: 1,
  at: n * 1000,
  endedAt: n * 1000 + 500,
  state: "done",
  app: "TextEdit",
  window: "Untitled",
  steps: [{ kind: "click", verb: "Clicked", object: "Save", inApp: "Save in TextEdit", state: "ok" }],
  text: false,
  rev: 2,
  ...over,
});

let push: (p: Push) => void = () => undefined;
beforeEach(() => {
  H.resetComputerHistory();
  const journal: Record<string, ComputerHistoryCall[]> = { t1: [call(1)], other: [call(1)] };
  const link = {
    environmentId: "local",
    connected: true,
    request: async (_method: string, params: { keys: string[] }) => ({ sessions: params.keys.map((key) => ({ key, born: 10, calls: journal[key] ?? [], more: false })) }),
    onPush: (fn: (p: Push) => void) => (push = fn),
    onOpen: () => undefined,
  };
  links.local = link;
  for (const l of links.listeners) l(link, "added");
});
afterEach(cleanup);

describe("useComputerHistory", () => {
  it("a push for another thread's key renders nothing in a reader of its own", async () => {
    let renders = 0;
    const mine = renderHook(() => {
      renders += 1;
      return H.useComputerHistory([{ key: "t1", threadId: "t1" }]);
    });
    const theirs = renderHook(() => H.useComputerHistory([{ key: "other", threadId: "other" }]));
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(mine.result.current.t1.calls).toHaveLength(1);
    const before = mine.result.current;
    const count = renders;
    // the other thread's call changes
    act(() => push({ push: "computer-history", key: "other", call: call(2, { rev: 1, state: "running" }) }));
    expect(theirs.result.current.other.calls).toHaveLength(2);
    expect(mine.result.current).toBe(before);
    expect(renders).toBe(count);
    // its own does render it, and only its key's history is a new object
    act(() => push({ push: "computer-history", key: "t1", call: call(2, { rev: 1, state: "running" }) }));
    expect(mine.result.current.t1.calls).toHaveLength(2);
    expect(renders).toBe(count + 1);
  });
});
