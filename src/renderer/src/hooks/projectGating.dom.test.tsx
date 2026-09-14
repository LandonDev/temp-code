// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "../lib/native";
import { useProjectBranchesState } from "./useProjectBranches";
import { useProjectDiffStats } from "./useProjectDiffStats";
import { useSlashCommands, slashCommandStore } from "../lib/tcserver/slashCommands";
import type { Link } from "../lib/tcserver/store";
import type { ServerPush } from "../lib/tcserver/types";

/**
 * The per-project fan-out that froze the machine: every mounted card,
 * composer and picker asked git for its project on boot and on focus. These
 * pin the rule that only the active one asks, and a disabled one costs nothing.
 */

vi.mock("../lib/native", () => ({
  invoke: vi.fn(() => Promise.resolve({ current: "main", detached: false, branches: [] })),
  open: vi.fn(),
}));

const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));
const callsFor = (method: string) =>
  vi.mocked(invoke).mock.calls.filter(([m]) => m === method).length;

class FakeLink implements Link {
  connected = true;
  calls: unknown[] = [];
  request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    return Promise.resolve([] as T);
  }
  onPush(_l: (push: ServerPush) => void) {
    return () => {};
  }
  onOpen() {
    return () => {};
  }
}

beforeEach(() => {
  vi.mocked(invoke).mockClear();
});

afterEach(() => {
  slashCommandStore.reset();
});

describe("useProjectDiffStats", () => {
  it("asks git only while enabled, and a focus while disabled asks nothing", async () => {
    const { rerender, result } = renderHook(
      ({ enabled }) => useProjectDiffStats("/repo-a", enabled),
      { initialProps: { enabled: false } },
    );
    await settle();
    act(() => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(callsFor("git_diff_stats")).toBe(0);
    expect(result.current).toBeNull();

    rerender({ enabled: true });
    await settle();
    expect(callsFor("git_diff_stats")).toBe(1);
  });
});

describe("useProjectBranchesState", () => {
  it("keeps the last branch list when disabled instead of asking again", async () => {
    const { rerender, result } = renderHook(
      ({ enabled }) => useProjectBranchesState("/repo-b", enabled),
      { initialProps: { enabled: true } },
    );
    await settle();
    expect(callsFor("git_branches")).toBe(1);
    expect(result.current.branches?.current).toBe("main");

    rerender({ enabled: false });
    act(() => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(callsFor("git_branches")).toBe(1);
    expect(result.current.branches?.current).toBe("main");
    expect(result.current.settled).toBe(true);
  });

  it("never asks for a project it was mounted disabled for", async () => {
    renderHook(() => useProjectBranchesState("/repo-c", false));
    await settle();
    expect(callsFor("git_branches")).toBe(0);
  });
});

describe("useSlashCommands", () => {
  it("lists commands only once the `/` menu opens", async () => {
    const link = new FakeLink();
    slashCommandStore.connect(link);
    const { rerender } = renderHook(
      ({ open }) => useSlashCommands("claude", "/repo-d", open),
      { initialProps: { open: false } },
    );
    await settle();
    expect(link.calls).toHaveLength(0);

    rerender({ open: true });
    await settle();
    expect(link.calls).toEqual([
      { method: "commands.list", params: { provider: "claude", cwd: "/repo-d" } },
    ]);
  });
});
