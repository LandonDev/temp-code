// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { tooltipChunk, warmTooltips } from "@renderer/components/ui/tooltip";
import { afterEach, describe, expect, it } from "vitest";
import { Heatmap, cellLabel, stepOf } from "./heatmap";

afterEach(cleanup);

describe("Heatmap", () => {
  it("draws 168 labelled cells, one tooltip, and the five ramp steps", () => {
    const { container } = render(
      <Heatmap
        data={[
          { dow: 2, hour: 15, value: 1_200_000 },
          { dow: 0, hour: 0, value: 100_000 },
        ]}
      />,
    );
    const cells = container.querySelectorAll("[data-step]");
    expect(cells).toHaveLength(168);
    expect([...cells].every((c) => c.getAttribute("aria-label"))).toBe(true);
    expect(container.querySelector('[aria-label="Tuesday 3 PM, 1.2M output tokens"]')?.getAttribute("data-step")).toBe("5");
    expect(container.querySelector('[aria-label="Sunday 12 AM, 100.0k output tokens"]')?.getAttribute("data-step")).toBe("1");
    expect(container.querySelectorAll("[data-ramp]")).toHaveLength(5);
    expect(document.querySelectorAll("[data-slot=tooltip]").length).toBeLessThanOrEqual(1);
  });

  it("reads a hovered cell out as every chart does, on a 4px grid", async () => {
    await tooltipChunk.load();
    await act(async () => warmTooltips());
    const { container } = render(<Heatmap data={[{ dow: 1, hour: 15, value: 12_400 }]} />);
    expect(container.querySelector("[data-slot=heatmap] > .grid")!.className).toContain("gap-1");
    expect(container.querySelector(".gap-\\[3px\\]")).toBeNull();
    const cell = container.querySelector('[aria-label="Monday 3 PM, 12.4k output tokens"]')!;
    fireEvent.pointerEnter(cell);
    fireEvent.pointerMove(cell);
    fireEvent.focus(cell);
    const tip = await waitFor(() => {
      const t = document.querySelector("[data-slot=chart-tooltip]");
      expect(t).toBeTruthy();
      return t!;
    });
    expect(tip.textContent).toContain("Monday 3 PM");
    expect(tip.textContent).toContain("Output");
    expect(tip.textContent).toContain("12.4k");
  });

  it("names a cell and steps its value against the busiest hour", () => {
    expect(cellLabel(1, 12, 0)).toBe("Monday 12 PM, 0 output tokens");
    expect(stepOf(0, 10)).toBe(0);
    expect(stepOf(1, 10)).toBe(1);
    expect(stepOf(10, 10)).toBe(5);
  });
});
