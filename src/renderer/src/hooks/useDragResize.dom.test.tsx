// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { animate } from "motion/react";
import { useDragResize } from "./useDragResize";

const glide = vi.hoisted(() => ({ stop: vi.fn() }));
vi.mock("motion/react", () => ({ animate: vi.fn(() => glide) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function Pane({ onCommit }: { onCommit: (width: number) => void }) {
  const resize = useDragResize({ min: 200, max: () => 500, defaultWidth: 300, initial: 300, onCommit });
  return (
    <section data-testid="pane" ref={resize.attachPane}>
      <div role="separator" onPointerDown={resize.onPointerDown} />
      <button onClick={() => resize.resizeTo(400)}>Resize</button>
      <button onClick={resize.reset}>Reset</button>
    </section>
  );
}

describe("useDragResize immediate resize", () => {
  it("rounds, clamps to the current bounds, paints and saves without a spring; reset clamps the default too", () => {
    const onCommit = vi.fn();
    const { result, rerender } = renderHook(({ max }) => useDragResize({
      min: 200, max: () => max, defaultWidth: 300, initial: 250, onCommit,
    }), { initialProps: { max: 500 } });
    const pane = document.createElement("section");
    act(() => result.current.attachPane(pane));
    act(() => result.current.resizeTo(900));
    expect(result.current.width).toBe(500);
    expect(pane.style.width).toBe("500px");
    expect(onCommit).toHaveBeenLastCalledWith(500);
    act(() => result.current.resizeTo(289.9));
    expect(result.current.width).toBe(290);
    expect(pane.style.width).toBe("290px");
    rerender({ max: 260 });
    act(() => result.current.reset());
    expect(result.current.width).toBe(260);
    expect(pane.style.width).toBe("260px");
    expect(onCommit).toHaveBeenLastCalledWith(260);
    act(() => result.current.resizeTo(-900));
    expect(result.current.width).toBe(200);
    expect(pane.style.width).toBe("200px");
    expect(animate).not.toHaveBeenCalled();
  });

  it("stops a settling drag before a key resize and starts the next drag at that width", () => {
    const onCommit = vi.fn();
    render(<Pane onCommit={onCommit} />);
    const pane = screen.getByTestId("pane");
    const handle = screen.getByRole("separator");
    Object.defineProperty(pane, "offsetWidth", { get: () => parseFloat(pane.style.width) });
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 0 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 1000 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(onCommit).toHaveBeenLastCalledWith(500);
    expect(animate).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Resize" }));
    expect(glide.stop).toHaveBeenCalledOnce();
    expect(pane.style.width).toBe("400px");
    expect(onCommit).toHaveBeenLastCalledWith(400);
    fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 0 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 20 });
    fireEvent.pointerUp(window, { pointerId: 2 });
    expect(pane.style.width).toBe("420px");
    expect(onCommit).toHaveBeenLastCalledWith(420);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(pane.style.width).toBe("300px");
    expect(onCommit).toHaveBeenLastCalledWith(300);
    expect(animate).toHaveBeenCalledOnce();
  });
});

/** A pointer event at a given time, so the drag reads a speed from it. */
function pointer(type: string, init: { pointerId: number; clientX?: number }, t: number) {
  const event = new PointerEvent(type, { bubbles: true, ...init });
  Object.defineProperty(event, "timeStamp", { value: t });
  return event;
}

describe("useDragResize released past a bound", () => {
  function setup(edge: "left" | "right") {
    const onCommit = vi.fn();
    function EdgePane() {
      const resize = useDragResize({ min: 200, max: () => 500, defaultWidth: 300, initial: 300, onCommit, edge });
      return (
        <section data-testid="pane" ref={resize.attachPane}>
          <div role="separator" onPointerDown={resize.onPointerDown} />
        </section>
      );
    }
    render(<EdgePane />);
    const pane = screen.getByTestId("pane");
    const handle = screen.getByRole("separator");
    Object.defineProperty(pane, "offsetWidth", { get: () => parseFloat(pane.style.width) });
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    return { onCommit, handle, pane };
  }

  it("springs back on SPRING_GLIDE carrying the pointer's speed, signed by the edge", () => {
    for (const [edge, sign] of [["right", 1], ["left", -1]] as const) {
      const { handle } = setup(edge);
      fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 0 });
      // 300px in 30ms toward the bound, then let go at once: 10,000px/s of travel.
      window.dispatchEvent(pointer("pointermove", { pointerId: 1, clientX: sign * 300 }, 1000));
      window.dispatchEvent(pointer("pointermove", { pointerId: 1, clientX: sign * 600 }, 1030));
      window.dispatchEvent(pointer("pointerup", { pointerId: 1 }, 1031));
      const [, keyframes, options] = vi.mocked(animate).mock.calls.at(-1)! as unknown as [unknown, { width: number[] }, { velocity: number; stiffness: number }];
      expect(keyframes.width[1]).toBe(500);
      expect(keyframes.width[0]).toBeGreaterThan(500);
      expect(options.velocity).toBeCloseTo(10000);
      expect(options.stiffness).toBe(700);
      cleanup();
    }
  });

  it("a lost pointer capture ends the drag and commits, as a release does", () => {
    const { handle, onCommit, pane } = setup("right");
    fireEvent.pointerDown(handle, { button: 0, pointerId: 3, clientX: 0 });
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 40 });
    handle.dispatchEvent(pointer("lostpointercapture", { pointerId: 3 }, 5000));
    expect(onCommit).toHaveBeenLastCalledWith(340);
    expect(document.documentElement.classList.contains("is-resizing")).toBe(false);
    // Later moves no longer move the pane.
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 90 });
    expect(pane.style.width).toBe("340px");
  });

  it("a window blur ends the drag with no speed", () => {
    const { handle, onCommit } = setup("right");
    fireEvent.pointerDown(handle, { button: 0, pointerId: 4, clientX: 0 });
    window.dispatchEvent(pointer("pointermove", { pointerId: 4, clientX: 900 }, 10));
    fireEvent.blur(window);
    expect(onCommit).toHaveBeenLastCalledWith(500);
    const options = vi.mocked(animate).mock.calls.at(-1)![2] as { velocity: number };
    expect(options.velocity).toBe(0);
  });
});
