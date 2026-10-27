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
    <section data-testid="pane" ref={resize.setPaneRef}>
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
    act(() => result.current.setPaneRef(pane));
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
