// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useSortable } from "./useSortable";

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

afterEach(cleanup);

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
