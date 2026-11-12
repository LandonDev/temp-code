// @vitest-environment jsdom
/**
 * What the Computer section and the title bar's cue read: the section is
 * there for a read that failed (its Retry must be reachable), the tree's
 * keys keep their identity through a push that moves no thread, and the cue
 * hears the metas only while its host has a live computer session.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerSessionRow } from "@server/shared/contract-computer";
import type { KeyHistory } from "./computerHistory";

const h = vi.hoisted(() => ({
  metas: [] as { id: string; parentId?: string; environmentId: string; title?: string }[],
  histories: {} as Record<string, unknown>,
  metasWhen: [] as boolean[],
}));
vi.mock("./native", () => ({ nativePlatform: () => "darwin" }));
vi.mock("./nativeWeb", () => ({ isWebMode: () => false }));
vi.mock("./tcserver/store", () => ({
  useSessionMeta: (id: string) => h.metas.find((m) => m.id === id) ?? null,
  useSessionMetas: () => h.metas,
  useSessionMetasWhen: (enabled: boolean) => {
    h.metasWhen.push(enabled);
    return enabled ? h.metas : [];
  },
}));
vi.mock("./computerHistory", async (original) => ({
  ...(await original<typeof import("./computerHistory")>()),
  useComputerHistory: () => h.histories,
}));

import { useComputerCue, useComputerSection } from "./computerSection";
import { computerSessionsStore } from "./computerSessions";

const history = (over: Partial<KeyHistory> = {}): KeyHistory => ({ born: 0, calls: [], more: false, status: "ready", ...over });
const row = (threadId: string): ComputerSessionRow => ({ threadId, since: 1, lastCallAt: 10, apps: [{ name: "TextEdit", bundleId: "com.apple.TextEdit", window: "Untitled" }], running: null, tier: "ax" });

beforeEach(() => {
  h.metas = [{ id: "root", environmentId: "local" }];
  h.histories = {};
  h.metasWhen.length = 0;
  computerSessionsStore.setState({ byHost: {} });
});
afterEach(cleanup);

describe("useComputerSection", () => {
  it("is nothing for a thread with no live session and no kept steps", () => {
    h.histories = { root: history() };
    const { result } = renderHook(() => useComputerSection("root"));
    expect(result.current).toMatchObject({ exists: false, live: false, keys: [{ key: "root", threadId: "root" }] });
  });

  it("says its first read is still out, so the panel does not take an unread history for an empty one", () => {
    // before the store has the key, and while the read is out
    const { result, rerender } = renderHook(() => useComputerSection("root"));
    expect(result.current).toMatchObject({ exists: false, loading: true });
    h.histories = { root: history({ status: "loading" }) };
    rerender();
    expect(result.current).toMatchObject({ exists: false, loading: true });
    h.histories = { root: history() };
    rerender();
    expect(result.current).toMatchObject({ exists: false, loading: false });
  });

  it("is there for a read that failed, so its Retry can be reached: a failure is not an empty history", () => {
    h.histories = { root: history({ status: "failed" }) };
    const { result } = renderHook(() => useComputerSection("root"));
    expect(result.current.exists).toBe(true);
  });

  it("keeps its keys through a push that moves no thread in or out of the tree, and follows one that does", () => {
    h.histories = { root: history() };
    const { result, rerender } = renderHook(() => useComputerSection("root"));
    const keys = result.current.keys;
    // another thread's status changed: a new metas array, the same tree
    h.metas = [{ id: "root", environmentId: "local" }, { id: "elsewhere", environmentId: "local" }];
    rerender();
    expect(result.current.keys).toBe(keys);
    h.metas = [...h.metas, { id: "sub1", parentId: "root", environmentId: "local" }];
    rerender();
    expect(result.current.keys.map((k) => k.key)).toEqual(["root", "sub1"]);
  });
});

describe("useComputerCue", () => {
  it("hears the metas only while its host has a live computer session", () => {
    const { result, rerender } = renderHook(() => useComputerCue("root"));
    expect(result.current).toBeNull();
    expect(h.metasWhen.every((on) => on === false)).toBe(true);
    act(() => computerSessionsStore.setState({ byHost: { local: [row("root")] } }));
    rerender();
    expect(h.metasWhen.at(-1)).toBe(true);
    expect(result.current).toMatchObject({ state: "working", label: "Using TextEdit" });
    // the session ends: the cue goes, and with it the subscription
    act(() => computerSessionsStore.setState({ byHost: { local: [] } }));
    rerender();
    expect(result.current).toBeNull();
    expect(h.metasWhen.at(-1)).toBe(false);
  });

  it("counts a subagent's session as the thread's own", () => {
    h.metas = [{ id: "root", environmentId: "local" }, { id: "sub1", parentId: "root", environmentId: "local" }];
    act(() => computerSessionsStore.setState({ byHost: { local: [row("sub1")] } }));
    const { result } = renderHook(() => useComputerCue("root"));
    expect(result.current?.label).toBe("Using TextEdit");
  });
});
