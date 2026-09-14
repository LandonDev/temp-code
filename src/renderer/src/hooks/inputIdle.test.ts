// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInputIdle } from "./inputIdle";

const input = (type: string) => act(() => void window.dispatchEvent(new Event(type)));
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("useInputIdle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("turns idle after the quiet spell and back on the next input", () => {
    const { result } = renderHook(() => useInputIdle(2000, true));
    expect(result.current).toBe(false);
    wait(1999);
    expect(result.current).toBe(false);
    wait(1);
    expect(result.current).toBe(true);
    input("pointermove");
    expect(result.current).toBe(false);
    wait(2000);
    expect(result.current).toBe(true);
  });

  it("input during the countdown pushes it back", () => {
    const { result } = renderHook(() => useInputIdle(2000, true));
    wait(1500);
    input("keydown");
    wait(1500);
    expect(result.current).toBe(false);
    wait(500);
    expect(result.current).toBe(true);
  });

  it("never counts while disabled and restarts the clock when enabled", () => {
    const { result, rerender } = renderHook(({ on }) => useInputIdle(2000, on), {
      initialProps: { on: false },
    });
    wait(5000);
    expect(result.current).toBe(false);
    rerender({ on: true });
    wait(1000);
    expect(result.current).toBe(false);
    wait(1000);
    expect(result.current).toBe(true);
    rerender({ on: false });
    expect(result.current).toBe(false);
    rerender({ on: true });
    expect(result.current).toBe(false);
    wait(2000);
    expect(result.current).toBe(true);
  });
});
