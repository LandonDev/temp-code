// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { OVERFLOW_FADE, useOverflowEdges } from "./useOverflowEdges";

afterEach(cleanup);

function Strip() {
  const edges = useOverflowEdges<HTMLDivElement>();
  return <div ref={edges} data-testid="strip" className={OVERFLOW_FADE} />;
}

describe("useOverflowEdges", () => {
  it("marks the edges that have more past them as the strip scrolls", () => {
    const { getByTestId } = render(<Strip />);
    const strip = getByTestId("strip");
    Object.defineProperty(strip, "clientWidth", { value: 300, configurable: true });
    Object.defineProperty(strip, "scrollWidth", { value: 900, configurable: true });
    const at = (left: number) => {
      strip.scrollLeft = left;
      fireEvent.scroll(strip);
      return [strip.hasAttribute("data-overflow-start"), strip.hasAttribute("data-overflow-end")];
    };
    expect(at(0)).toEqual([false, true]);
    expect(at(300)).toEqual([true, true]);
    expect(at(600)).toEqual([true, false]);
    // Each flag fades its own edge 24px; none at rest.
    expect(strip.className).toContain("data-overflow-start:[--fade-start:24px]");
    expect(strip.className).toContain("data-overflow-end:[--fade-end:24px]");
  });
});
