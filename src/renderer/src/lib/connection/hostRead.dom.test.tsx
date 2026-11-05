// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Link } from "./link";
import { useHostRead } from "./hostRead";
import { LOAD_DEADLINE_MS, NO_ANSWER } from "./openRead";

function fakeLink(connected: boolean) {
  const opens = new Set<() => void>();
  const link = {
    connected,
    onOpen: (fn: () => void) => {
      opens.add(fn);
      return () => opens.delete(fn);
    },
  };
  return {
    link: link as unknown as Link,
    open: () => {
      link.connected = true;
      for (const fn of [...opens]) fn();
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useHostRead", () => {
  it("waits for the socket to open before it asks", async () => {
    const { link, open } = fakeLink(false);
    const read = vi.fn(async () => 7);
    const { result } = renderHook(() => useHostRead(link, read));
    await act(async () => {});
    expect(read).not.toHaveBeenCalled();
    await act(async () => open());
    expect(read).toHaveBeenCalledOnce();
    expect(result.current.value).toBe(7);
  });

  it("says the host did not answer past the deadline, never a made-up value, and a late answer still lands", async () => {
    const { link } = fakeLink(true);
    let answer: (n: number) => void = () => {};
    const { result } = renderHook(() => useHostRead(link, () => new Promise<number>((r) => (answer = r))));
    await act(async () => vi.advanceTimersByTime(LOAD_DEADLINE_MS));
    expect(result.current.value).toBeUndefined();
    expect(result.current.error).toBe(NO_ANSWER);
    await act(async () => answer(3));
    expect(result.current.value).toBe(3);
    expect(result.current.error).toBeNull();
  });

  it("reports a refusal, and Retry asks again", async () => {
    const { link } = fakeLink(true);
    const read = vi.fn().mockRejectedValueOnce(new Error("refused")).mockResolvedValueOnce("ok");
    const { result } = renderHook(() => useHostRead(link, read));
    await act(async () => {});
    expect(result.current.error).toBe("refused");
    await act(async () => result.current.retry());
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ value: "ok", error: null });
  });

  it("asks again when a new socket opens while the value is missing", async () => {
    const { link, open } = fakeLink(true);
    const read = vi.fn().mockRejectedValueOnce(new Error("dropped")).mockResolvedValueOnce(1);
    const { result } = renderHook(() => useHostRead(link, read));
    await act(async () => {});
    await act(async () => open());
    expect(result.current.value).toBe(1);
  });

  it("keeps the value through a failed refresh, and starts over for a new key", async () => {
    const { link } = fakeLink(true);
    const read = vi.fn().mockResolvedValueOnce("a").mockRejectedValueOnce(new Error("busy")).mockReturnValue(new Promise(() => {}));
    const { result, rerender } = renderHook(({ k }) => useHostRead(link, read, k), { initialProps: { k: "one" } });
    await act(async () => {});
    await act(async () => result.current.retry());
    expect(result.current).toMatchObject({ value: "a", error: "busy" });
    rerender({ k: "two" });
    expect(result.current).toMatchObject({ value: undefined, error: null });
  });
});
