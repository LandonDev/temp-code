// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Counts } from "./Counts";

afterEach(cleanup);

const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

describe("Counts", () => {
  it("draws at the text's size: no size of its own, tabular", () => {
    const { container } = render(<Counts added={46} removed={3} failed={2} />);
    const counts = container.querySelector('[data-slot="counts"]')!;
    expect(classes(counts)).toContain("tabular-nums");
    expect(classes(counts)).not.toContain("text-xs");
    expect(container.textContent).toContain("+46");
    expect(container.textContent).toContain("−3");
  });

  it("draws the failed mark at the text's size with 4px to its number", () => {
    const { getByLabelText } = render(<Counts failed={2} />);
    const mark = getByLabelText("2 failed");
    expect(classes(mark)).toEqual(expect.arrayContaining(["gap-1", "text-[length:inherit]", "font-normal"]));
    expect(classes(mark)).not.toContain("text-xs");
    expect(classes(mark)).not.toContain("gap-2");
  });

  it("takes a size from a caller outside the transcript", () => {
    const { container } = render(<Counts added={1} className="text-xs" />);
    expect(classes(container.querySelector('[data-slot="counts"]')!)).toContain("text-xs");
  });

  it("draws nothing with nothing to say", () => {
    const { container } = render(<Counts />);
    expect(container.firstChild).toBeNull();
  });
});
