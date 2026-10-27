// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNow } from "../lib/duration";
import { PaneVisibilityContext } from "./paneVisibility";

const parked = ({ children }: { children: ReactNode }) => (
  <PaneVisibilityContext.Provider value={false}>{children}</PaneVisibilityContext.Provider>
);

describe("pane visibility gate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("useNow ticks in a shown pane", () => {
    const { result } = renderHook(() => useNow(true));
    const first = result.current;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBeGreaterThan(first);
  });

  it("useNow schedules nothing in a parked pane", () => {
    const { result } = renderHook(() => useNow(true), { wrapper: parked });
    const first = result.current;
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(result.current).toBe(first);
    expect(vi.getTimerCount()).toBe(0);
  });
});
