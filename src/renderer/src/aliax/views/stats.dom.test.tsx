// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatsView, paceLine, paceTitle } from "./stats";
import { STATS } from "./stats.fixtures";

afterEach(cleanup);

const headings = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
const ORDER = ["Pace", "Daily output", "Model mix", "Top projects", "Cache hit rate", "When you burn limit", "Tools used"];

describe("Stats", () => {
  it("holds every pace series in one Pace section: seven sections in all", () => {
    render(<StatsView data={STATS} status={null} />);
    expect(headings()).toEqual(ORDER);
    const pace = screen.getByRole("region", { name: "Pace" });
    const series = pace.querySelectorAll("[data-slot=pace-series]");
    expect(series).toHaveLength(2);
    STATS.pace.forEach((p, i) => {
      expect(series[i].textContent).toContain(paceTitle(p));
      expect(series[i].textContent).toContain(paceLine(p).text);
    });
    // The one running out reads amber; a line is two facts with no dot between them.
    const words = screen.getByText(paceLine(STATS.pace[1]).text);
    expect(words.className).toContain("text-warning");
    expect(pace.textContent).not.toContain("·");
  });

  it("keeps the empty pace inside the same section", () => {
    render(<StatsView data={{ ...STATS, pace: [] }} status={null} />);
    expect(headings()).toEqual(ORDER);
    expect(screen.getByRole("region", { name: "Pace" }).textContent).toContain("Needs three finished cycles");
  });

  it("loads under the same seven headings", () => {
    render(<StatsView data={null} status={null} />);
    expect(headings()).toEqual(ORDER);
  });
});
