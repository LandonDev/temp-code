// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNearViewport } from "./useNearViewport";

function Probe({ onNear }: { onNear: (near: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  onNear(useNearViewport(ref));
  return <div ref={ref} />;
}

/** A stand-in observer that lets the test fire an intersection. */
class FakeObserver {
  static instances: FakeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(public cb: (entries: { isIntersecting: boolean }[]) => void) {
    FakeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  disconnect() {
    this.disconnected = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeObserver.instances = [];
});

describe("useNearViewport", () => {
  it("is false until the element nears the viewport, then stays true", () => {
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    const seen: boolean[] = [];
    render(<Probe onNear={(n) => seen.push(n)} />);
    expect(seen.at(-1)).toBe(false);
    expect(FakeObserver.instances).toHaveLength(1);
    expect(FakeObserver.instances[0].observed).toHaveLength(1);
    act(() => FakeObserver.instances[0].cb([{ isIntersecting: false }]));
    expect(seen.at(-1)).toBe(false);
    act(() => FakeObserver.instances[0].cb([{ isIntersecting: true }]));
    expect(seen.at(-1)).toBe(true);
    expect(FakeObserver.instances[0].disconnected).toBe(true);
  });

  it("is true at once without an observer", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const seen: boolean[] = [];
    render(<Probe onNear={(n) => seen.push(n)} />);
    expect(seen).toEqual([true]);
  });
});
