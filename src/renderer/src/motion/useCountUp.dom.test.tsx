// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DUR, EASE_OUT } from "../lib/ease";

type Options = { duration: number; ease: readonly number[]; onUpdate: (value: number) => void };
const calls = vi.hoisted(() => [] as { from: number; to: number; options: Options; stop: () => void }[]);
const reduced = vi.hoisted(() => ({ value: false }));
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return {
    ...actual,
    useReducedMotion: () => reduced.value,
    animate: (from: number, to: number, options: Options) => {
      const call = { from, to, options, stop: vi.fn() };
      calls.push(call);
      return { stop: call.stop };
    },
  };
});

import { useCountUp } from "./useCountUp";

afterEach(() => {
  cleanup();
  calls.length = 0;
  reduced.value = false;
});

describe("useCountUp", () => {
  it("returns the target when off", () => {
    expect(renderHook(() => useCountUp(46, false)).result.current).toBe(46);
    reduced.value = true;
    expect(renderHook(() => useCountUp(12, true)).result.current).toBe(12);
    expect(calls).toHaveLength(0);
  });

  it("ticks over DUR.slow on EASE_OUT, and a new target starts from the value on screen", () => {
    const { result, rerender } = renderHook(({ target }) => useCountUp(target, true), { initialProps: { target: 46 } });
    expect(calls[0]).toMatchObject({ from: 0, to: 46, options: { duration: DUR.slow, ease: EASE_OUT } });
    act(() => calls[0].options.onUpdate(20.4));
    expect(result.current).toBe(20);
    rerender({ target: 60 });
    expect(calls[0].stop).toHaveBeenCalled();
    expect(calls[1]).toMatchObject({ from: 20, to: 60 });
    act(() => calls[1].options.onUpdate(60));
    expect(result.current).toBe(60);
  });
});
