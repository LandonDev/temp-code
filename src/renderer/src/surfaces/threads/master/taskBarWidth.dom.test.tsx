// @vitest-environment jsdom
/** The board measures its one bar width before paint and again when the set
 *  of task labels changes, never for a re-render with the same labels. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTaskBarWidth } from "./taskBarWidth";

afterEach(cleanup);

function Probe({ labels, measure }: { labels: string; measure: (text: string) => number }) {
  const width = useTaskBarWidth(labels, measure);
  return <div data-width={width ?? ""} />;
}

const read = (c: HTMLElement) => c.querySelector("[data-width]")!.getAttribute("data-width");

describe("useTaskBarWidth", () => {
  it("measures before paint, re-measures when a label changes, and not for the same labels", () => {
    const measure = vi.fn((text: string) => text.length * 6);
    const { container, rerender } = render(<Probe labels={"Docs\nTests"} measure={measure} />);
    expect(read(container)).toBe("160");
    const calls = measure.mock.calls.length;
    rerender(<Probe labels={"Docs\nTests"} measure={measure} />);
    expect(measure.mock.calls.length).toBe(calls);
    rerender(<Probe labels={"Docs\nWrite the project header rows with their glyphs"} measure={measure} />);
    expect(read(container)).toBe(String(12 + 6 + "Write the project header rows with their glyphs".length * 6));
  });

  it("stays unmeasured where nothing can measure (no canvas)", () => {
    function Bare() {
      return <div data-width={useTaskBarWidth("Docs") ?? ""} />;
    }
    const { container } = render(<Bare />);
    expect(read(container)).toBe("");
  });
});
