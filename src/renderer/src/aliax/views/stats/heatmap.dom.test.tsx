// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
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

  it("names a cell and steps its value against the busiest hour", () => {
    expect(cellLabel(1, 12, 0)).toBe("Monday 12 PM, 0 output tokens");
    expect(stepOf(0, 10)).toBe(0);
    expect(stepOf(1, 10)).toBe(1);
    expect(stepOf(10, 10)).toBe(5);
  });
});
