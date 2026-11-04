// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCK_SIZE_DEFAULT } from "../lib/projectTerminal";
import { animate } from "motion/react";
import { DockFrame } from "./DockFrame";

vi.mock("motion/react", () => ({
  animate: vi.fn((_from: number, to: number, options: { onUpdate?: (v: number) => void; onComplete?: () => void }) => {
    options.onUpdate?.(to);
    options.onComplete?.();
    return { stop: vi.fn() };
  }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Dock() {
  const [size, setSize] = useState(300);
  return <DockFrame size={size} focused label="Resize terminal" onFocus={() => {}} onSizePaint={() => {}} onSizeCommit={setSize}>Terminal</DockFrame>;
}

describe("DockFrame sash", () => {
  it("is focusable, moves up by 2% or Shift 10%, and resets on double-click", () => {
    vi.stubGlobal("innerHeight", 800);
    const { container } = render(<Dock />);
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ height: 1000 } as DOMRect);
    const handle = screen.getByRole("separator", { name: "Resize terminal" });
    handle.focus();
    expect(document.activeElement).toBe(handle);
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
    expect(handle.className).toContain("focus-visible:bg-accent");
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(handle.getAttribute("aria-valuenow")).toBe("320");
    fireEvent.keyDown(handle, { key: "ArrowUp", shiftKey: true });
    expect(handle.getAttribute("aria-valuenow")).toBe("420");
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(handle.getAttribute("aria-valuenow")).toBe("400");
    fireEvent.doubleClick(handle);
    expect(handle.getAttribute("aria-valuenow")).toBe(String(DOCK_SIZE_DEFAULT));
  });
});

function pointer(type: string, init: { pointerId: number; clientY?: number }, t: number) {
  const event = new PointerEvent(type, { bubbles: true, ...init });
  Object.defineProperty(event, "timeStamp", { value: t });
  return event;
}

describe("DockFrame drag", () => {
  function setup() {
    vi.stubGlobal("innerHeight", 800);
    const onSizePaint = vi.fn();
    const onSizeCommit = vi.fn();
    render(<DockFrame size={300} focused label="Resize terminal" onFocus={() => {}} onSizePaint={onSizePaint} onSizeCommit={onSizeCommit}>Terminal</DockFrame>);
    const handle = screen.getByRole("separator", { name: "Resize terminal" });
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    handle.hasPointerCapture = () => true;
    return { handle, onSizePaint, onSizeCommit };
  }
  afterEach(() => vi.mocked(animate).mockClear());

  it("keeps text from selecting while it drags, and past its top settles back on SPRING_GLIDE with the pointer's speed", () => {
    const { handle, onSizePaint, onSizeCommit } = setup();
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 500 });
    expect(document.documentElement.classList.contains("is-resizing")).toBe(true);
    expect(document.documentElement.classList.contains("is-reordering")).toBe(true);
    // 0.7 of 800 is the bound, 560; the pointer goes well past it, rising fast.
    handle.dispatchEvent(pointer("pointermove", { pointerId: 1, clientY: 100 }, 1000));
    handle.dispatchEvent(pointer("pointermove", { pointerId: 1, clientY: 0 }, 1020));
    handle.dispatchEvent(pointer("pointerup", { pointerId: 1 }, 1021));
    const [from, to, options] = vi.mocked(animate).mock.calls.at(-1)! as unknown as [number, number, { velocity: number; stiffness: number }];
    expect(from).toBeGreaterThan(560);
    expect(to).toBe(560);
    // The size grows as the pointer rises: 100px up in 20ms is +5,000px/s.
    expect(options.velocity).toBeCloseTo(5000);
    expect(options.stiffness).toBe(700);
    expect(onSizePaint).toHaveBeenLastCalledWith(560);
    expect(onSizeCommit).toHaveBeenLastCalledWith(560);
    expect(document.documentElement.classList.contains("is-resizing")).toBe(false);
  });

  it("a lost capture or a window blur ends the drag and commits", () => {
    const { handle, onSizeCommit } = setup();
    fireEvent.pointerDown(handle, { pointerId: 2, clientY: 500 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientY: 480 });
    handle.dispatchEvent(pointer("lostpointercapture", { pointerId: 2 }, 50));
    expect(onSizeCommit).toHaveBeenLastCalledWith(320);
    fireEvent.pointerDown(handle, { pointerId: 3, clientY: 500 });
    fireEvent.pointerMove(handle, { pointerId: 3, clientY: 450 });
    fireEvent.blur(window);
    expect(onSizeCommit).toHaveBeenLastCalledWith(350);
  });
});
