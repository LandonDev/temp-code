// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { animate } from "motion/react";
import { SPRING_GLIDE } from "../lib/ease";
import { useSortable } from "./useSortable";

// A glide lands at once, so a test reads where it ends; the call is kept to read its spring.
vi.mock("motion/react", () => ({
  animate: vi.fn((_from: number, to: number, options: { onUpdate?: (v: number) => void; onComplete?: () => void }) => {
    options.onUpdate?.(to);
    options.onComplete?.();
    return { stop: vi.fn() };
  }),
}));

function List() {
  const sortable = useSortable(["a", "b"], () => {}, "y");
  return (
    <div>
      {["a", "b"].map((id) => (
        <button key={id} type="button" ref={(el) => sortable.setItemRef(id, el)} onPointerDown={(e) => sortable.onItemPointerDown(id, e)}>
          {id}
        </button>
      ))}
    </div>
  );
}

// jsdom has no pointer capture.
HTMLElement.prototype.setPointerCapture ??= () => {};
HTMLElement.prototype.releasePointerCapture ??= () => {};

const selectStartPrevented = (): boolean => !window.dispatchEvent(new Event("selectstart", { cancelable: true }));
const reordering = (): boolean => document.documentElement.classList.contains("is-reordering");

afterEach(() => {
  cleanup();
  vi.mocked(animate).mockClear();
  vi.restoreAllMocks();
});

/** A list that reorders as a parent would, its rows 20px tall in a column. */
function Reorderable() {
  const [ids, setIds] = useState(["a", "b", "c"]);
  const sortable = useSortable(ids, setIds, "y");
  return (
    <div>
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          data-row={id}
          ref={(el) => sortable.setItemRef(id, el)}
          onPointerDown={(e) => sortable.onItemPointerDown(id, e)}
        >
          {id}
        </button>
      ))}
    </div>
  );
}

/** Each row's box from its place in the DOM, its `translate` added, as a browser would draw it. */
function layOut() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const index = [...(this.parentElement?.children ?? [])].indexOf(this);
    const y = parseFloat((this.style.translate || "0px 0px").split(" ")[1]!) || 0;
    const top = index * 20 + y;
    return { left: 0, right: 100, width: 100, top, bottom: top + 20, height: 20, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
}

describe("useSortable", () => {
  it("a press starts no selection but restyles nothing; only a drag turns selection off for the document", () => {
    const view = render(<List />);
    fireEvent.pointerDown(view.getByText("a"), { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    expect(reordering()).toBe(false);
    expect(selectStartPrevented()).toBe(true);
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: 30 });
    expect(reordering()).toBe(true);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 10, clientY: 30 });
    expect(reordering()).toBe(false);
    expect(selectStartPrevented()).toBe(false);
  });

  it("a click lets selection go again on release", () => {
    const view = render(<List />);
    fireEvent.pointerDown(view.getByText("b"), { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 11, clientY: 10 });
    expect(reordering()).toBe(false);
    expect(selectStartPrevented()).toBe(false);
  });
});

describe("useSortable's dragged row", () => {
  const row = (id: string) => document.querySelector<HTMLElement>(`[data-row="${id}"]`)!;

  it("follows the pointer on the axis from where it was grabbed, and the others hold still", () => {
    layOut();
    render(<Reorderable />);
    fireEvent.pointerDown(row("a"), { button: 0, pointerId: 1, clientX: 50, clientY: 12 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 70, clientY: 22 });
    expect(row("a").style.translate).toBe("0px 10px");
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 90, clientY: 26 });
    expect(row("a").style.translate).toBe("0px 14px");
    expect(row("b").style.translate).toBe("");
    expect(row("c").style.translate).toBe("");
  });

  it("Escape glides it back to its own slot on SPRING_GLIDE", () => {
    layOut();
    render(<Reorderable />);
    fireEvent.pointerDown(row("a"), { button: 0, pointerId: 1, clientX: 50, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 50, clientY: 40 });
    fireEvent.keyDown(window, { key: "Escape" });
    const [from, to, options] = vi.mocked(animate).mock.calls.at(-1)! as unknown as [number, number, typeof SPRING_GLIDE];
    expect([from, to]).toEqual([30, 0]);
    expect(options.stiffness).toBe(SPRING_GLIDE.stiffness);
    expect(row("a").style.translate).toBe("");
    expect(document.querySelectorAll("button")[0]!.textContent).toBe("a");
  });

  it("a drop into a new slot glides from where the pointer left it into that slot (one row's FLIP)", () => {
    layOut();
    render(<Reorderable />);
    // Grab a at 10, carry it 15px down: drawn at 15, past its own middle, before b's.
    fireEvent.pointerDown(row("a"), { button: 0, pointerId: 1, clientX: 50, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 50, clientY: 25 });
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 50, clientY: 25 });
    });
    expect([...document.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["b", "a", "c"]);
    // a now sits at 20 and was drawn at 15: it glides the last 5px down into its slot.
    const [from, to, options] = vi.mocked(animate).mock.calls.at(-1)! as unknown as [number, number, typeof SPRING_GLIDE];
    expect([from, to]).toEqual([-5, 0]);
    expect(options.damping).toBe(SPRING_GLIDE.damping);
    expect(row("a").style.translate).toBe("");
  });

  it("under reduced motion the row does not follow and the drop lands at once", () => {
    layOut();
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList);
    render(<Reorderable />);
    fireEvent.pointerDown(row("a"), { button: 0, pointerId: 1, clientX: 50, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 50, clientY: 45 });
    expect(row("a").style.translate).toBe("");
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 50, clientY: 45 });
    });
    expect(animate).not.toHaveBeenCalled();
    expect(row("a").style.translate).toBe("");
  });
});
