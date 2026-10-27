// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Line, LineChart } from "recharts";
import { ChartFrame, LINE } from "./chart";
import { ChartLegend } from "./legend";
import { SERIES, ramp } from "./palette";

// jsdom has no layout, so ResponsiveContainer would measure 0×0 and draw nothing.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return { ...actual, ResponsiveContainer: ({ children }: { children: ReactNode }) => <div style={{ width: 600, height: 200 }}>{children}</div> };
});

// A chart mounts once it nears the viewport; here it always has.
class SeenObserver {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(): void {
    this.cb([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  disconnect(): void {}
}

beforeEach(() => vi.stubGlobal("IntersectionObserver", SeenObserver));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const data = [
  { day: "a", x: 1, y: 2 },
  { day: "b", x: 3, y: 1 },
];

describe("the chart module", () => {
  it("draws a legend only for two or more series", () => {
    const { container, rerender } = render(<ChartLegend items={[{ label: "One", color: SERIES[0] }]} />);
    expect(container.querySelector("[data-slot=chart-legend]")).toBeNull();
    rerender(
      <ChartLegend
        items={[
          { label: "One", color: SERIES[0] },
          { label: "Two", color: SERIES[1] },
        ]}
      />,
    );
    expect(container.querySelector("[data-slot=chart-legend]")?.textContent).toBe("OneTwo");
  });

  it("frames the plot and paints series with the chart tokens", async () => {
    const { container } = render(
      <ChartFrame label="Two lines">
        <LineChart data={data} width={600} height={200}>
          <Line {...LINE} dataKey="x" stroke={SERIES[0]} />
          <Line {...LINE} dataKey="y" stroke={SERIES[1]} />
        </LineChart>
      </ChartFrame>,
    );
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const frame = container.querySelector("[data-chart]");
    expect(frame?.getAttribute("aria-label")).toBe("Two lines");
    const strokes = [...container.querySelectorAll(".recharts-line-curve")].map((p) => p.getAttribute("stroke"));
    expect(strokes).toEqual(["var(--chart-1)", "var(--chart-2)"]);
  });

  it("ramps from the background to the first chart colour", () => {
    expect(ramp(0)).toBe("transparent");
    expect(ramp(5)).toBe("color-mix(in oklab, var(--chart-1) 100%, var(--background))");
    expect(ramp(1)).toBe("color-mix(in oklab, var(--chart-1) 20%, var(--background))");
  });
});
