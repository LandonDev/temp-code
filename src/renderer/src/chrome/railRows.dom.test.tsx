// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { virtualChunk } from "../surfaces/chunks";
import { RailRows, VIRTUAL_AT_ROWS } from "./railRows";

afterEach(cleanup);

const KEYS = ["a", "b", "c", "d", "e"];

function List({ rows }: { rows: number }) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setScroller} data-testid="scroller" style={{ height: 120, overflowY: "auto" }}>
      <RailRows
        count={KEYS.length}
        rows={rows}
        scroller={scroller}
        scrollMargin={0}
        estimateSize={() => 32}
        getItemKey={(i) => KEYS[i]}
        render={(i) => <span data-card={KEYS[i]}>{KEYS[i]}</span>}
        reveal={null}
      />
    </div>
  );
}

const cards = (root: HTMLElement) => [...root.querySelectorAll("[data-card]")].map((el) => el.getAttribute("data-card"));

describe("RailRows", () => {
  it("renders every card in order, in flow, before the virtualizer has loaded", () => {
    expect(virtualChunk.loaded()).toBeNull();
    const { container } = render(<List rows={KEYS.length} />);
    expect(cards(container)).toEqual(KEYS);
    expect([...container.querySelectorAll("[data-index]")].map((el) => el.getAttribute("data-index"))).toEqual(["0", "1", "2", "3", "4"]);
    expect(container.querySelector(".relative.w-full")).toBeNull();
  });

  it("past the row threshold loads the virtualizer at once and swaps in, keeping the scroll offset", async () => {
    const { container, getByTestId } = render(<List rows={VIRTUAL_AT_ROWS + 1} />);
    const scroller = getByTestId("scroller");
    scroller.scrollTop = 40;
    // jsdom does not scroll: record where the virtualizer asks the scroller to go.
    const scrolledTo: number[] = [];
    scroller.scrollTo = ((options: ScrollToOptions) => scrolledTo.push(options.top ?? 0)) as typeof scroller.scrollTo;
    expect(container.querySelector(".relative.w-full")).toBeNull();
    await act(async () => {
      await virtualChunk.load();
    });
    await act(async () => {});
    // The virtual list: one positioned box sized to the cards, the same scroller.
    expect(container.querySelector(".relative.w-full")).not.toBeNull();
    expect(getByTestId("scroller")).toBe(scroller);
    expect(scroller.scrollTop).toBe(40);
    expect(scrolledTo.every((top) => top === 40)).toBe(true);
    // Once loaded, a new list virtualizes from its first render.
    cleanup();
    const again = render(<List rows={KEYS.length} />);
    expect(again.container.querySelector(".relative.w-full")).not.toBeNull();
  });
});
