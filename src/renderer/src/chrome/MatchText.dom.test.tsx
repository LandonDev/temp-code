// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MatchText, matchRanges } from "./MatchText";

/**
 * The one highlighter: fuzzy positions fold into runs, a query marks the
 * phrase or else each word once, a regex its first match, and the marks
 * are weight in the foreground, never the accent.
 */

describe("matchRanges", () => {
  it("folds positions into runs", () => {
    expect(matchRanges("gateway", { positions: [0, 1, 2, 5, 9] })).toEqual([
      [0, 3],
      [5, 6],
    ]);
  });

  it("marks the whole phrase where it appears", () => {
    expect(matchRanges("the gateway trace", { query: "Gateway Trace" })).toEqual([[4, 17]]);
  });

  it("falls back to the first occurrence of each word", () => {
    expect(matchRanges("trace the gateway, trace", { query: "gateway trace" })).toEqual([
      [0, 5],
      [10, 17],
    ]);
  });

  it("honours case sensitivity", () => {
    expect(matchRanges("Gateway", { query: "gateway", caseSensitive: true })).toEqual([]);
    expect(matchRanges("Gateway", { query: "Gate", caseSensitive: true })).toEqual([[0, 4]]);
  });

  it("marks a regex's first match and nothing for an invalid pattern", () => {
    expect(matchRanges("a1 b22 c333", { query: "\\d{2,}", regex: true })).toEqual([[4, 6]]);
    expect(matchRanges("a1 b22", { query: "(", regex: true })).toEqual([]);
    expect(matchRanges("abc", { query: "x*", regex: true })).toEqual([]);
  });
});

describe("MatchText", () => {
  it("renders runs as semibold foreground marks without colour", () => {
    const { container } = render(<MatchText text="gateway" positions={[0, 1]} />);
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("ga");
    expect(marks[0].className).toContain("font-semibold");
    expect(marks[0].className).toContain("text-foreground");
    expect(marks[0].className).not.toMatch(/text-accent|bg-accent/);
    expect(container.textContent).toBe("gateway");
  });

  it("marks nothing when inactive", () => {
    const { container } = render(<MatchText text="gateway" positions={[0, 1]} active={false} />);
    expect(container.querySelector("mark")).toBeNull();
    expect(container.textContent).toBe("gateway");
  });

  it("takes a query", () => {
    const { container } = render(<MatchText text="open the gateway" query="gateway" />);
    expect(container.querySelector("mark")?.textContent).toBe("gateway");
  });
});
