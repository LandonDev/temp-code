// @vitest-environment jsdom
import { act, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalSpinner } from "../chrome/TerminalSpinner";
import { useNow } from "../surfaces/threads/bits";
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
    const { result } = renderHook(() => useNow(true, 100));
    const first = result.current;
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(result.current).toBeGreaterThan(first);
  });

  it("useNow schedules nothing in a parked pane", () => {
    const { result } = renderHook(() => useNow(true, 100), { wrapper: parked });
    const first = result.current;
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(result.current).toBe(first);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("TerminalSpinner holds one frame in a parked pane", () => {
    render(<TerminalSpinner />, { wrapper: parked });
    const frame = screen.getByText(/./).textContent;
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByText(/./).textContent).toBe(frame);
    expect(vi.getTimerCount()).toBe(0);
  });
});
