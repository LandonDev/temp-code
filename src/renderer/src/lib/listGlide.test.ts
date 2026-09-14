// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GLIDE_MAX_ROWS, SETTLE_MS, sameIds, swappedWholesale, useListGlide } from "./listGlide";

afterEach(cleanup);

describe("swappedWholesale", () => {
  it("is a swap when fewer than half the next ids were already there", () => {
    expect(swappedWholesale(["a", "b", "c"], ["x", "y", "z"])).toBe(true);
    expect(swappedWholesale(["a", "b", "c"], ["a", "x", "y", "z"])).toBe(true);
    expect(swappedWholesale(["a", "b", "c"], ["a", "b", "x"])).toBe(false);
    expect(swappedWholesale(["a", "b"], ["a", "b", "c", "d"])).toBe(false);
  });
  it("treats the first fill as a swap and an emptied list as none", () => {
    expect(swappedWholesale([], ["a"])).toBe(true);
    expect(swappedWholesale(["a"], [])).toBe(false);
  });
  it("sameIds compares by position", () => {
    expect(sameIds(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameIds(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameIds(["a"], ["a", "b"])).toBe(false);
  });
});

describe("useListGlide", () => {
  it("glides on a settled list and stops for the swap until it settles", () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(({ ids }) => useListGlide(ids), {
        initialProps: { ids: ["a", "b", "c"] },
      });
      expect(result.current).toEqual({ generation: 0, glide: true });

      rerender({ ids: ["a", "b", "c", "d"] });
      expect(result.current).toEqual({ generation: 0, glide: true });

      rerender({ ids: ["x", "y"] });
      expect(result.current).toEqual({ generation: 1, glide: false });
      act(() => void vi.advanceTimersByTime(SETTLE_MS - 1));
      expect(result.current.glide).toBe(false);
      act(() => void vi.advanceTimersByTime(1));
      expect(result.current).toEqual({ generation: 1, glide: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts the settle clock on a second swap and keeps one generation per swap", () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(({ ids }) => useListGlide(ids), {
        initialProps: { ids: ["a"] },
      });
      rerender({ ids: ["b"] });
      act(() => void vi.advanceTimersByTime(SETTLE_MS / 2));
      rerender({ ids: ["c"] });
      expect(result.current).toEqual({ generation: 2, glide: false });
      act(() => void vi.advanceTimersByTime(SETTLE_MS / 2));
      expect(result.current.glide).toBe(false);
      act(() => void vi.advanceTimersByTime(SETTLE_MS / 2));
      expect(result.current).toEqual({ generation: 2, glide: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never glides past the row cap", () => {
    const many = Array.from({ length: GLIDE_MAX_ROWS + 1 }, (_, i) => `t${i}`);
    const { result, rerender } = renderHook(({ ids }) => useListGlide(ids), {
      initialProps: { ids: many },
    });
    expect(result.current.glide).toBe(false);
    rerender({ ids: many.slice(1) });
    expect(result.current).toEqual({ generation: 0, glide: true });
  });
});
