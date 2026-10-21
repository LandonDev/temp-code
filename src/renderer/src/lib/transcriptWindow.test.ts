import { describe, expect, it } from "vitest";
import { RowLayout, anchorShift, rangeCovers } from "./transcriptWindow";

const rows = (n: number, estimate = 40, prefix = "r") =>
  Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i}`, estimate }));

describe("RowLayout", () => {
  it("lays rows out from estimates and replaces them with measurements", () => {
    const layout = new RowLayout();
    layout.setRows(rows(5));
    expect(layout.total()).toBe(200);
    expect(layout.offsetOf(3)).toBe(120);
    expect(layout.measure("r1", 100)).toEqual({ index: 1, delta: 60 });
    expect(layout.total()).toBe(260);
    expect(layout.offsetOf(3)).toBe(180);
    expect(layout.offsetOf(1)).toBe(40);
    // A measurement within half a pixel is the one it replaces.
    expect(layout.measure("r1", 100.3)).toBeNull();
    expect(layout.measure("r1", 80)).toEqual({ index: 1, delta: -20 });
    expect(layout.total()).toBe(240);
  });

  it("keeps measured heights by key across a rebuild with rows added above", () => {
    const layout = new RowLayout();
    layout.setRows(rows(3));
    layout.measure("r2", 90);
    layout.setRows([...rows(2, 40, "old"), ...rows(3)]);
    expect(layout.indexOf("r2")).toBe(4);
    expect(layout.sizeOf(4)).toBe(90);
    expect(layout.offsetOf(4)).toBe(2 * 40 + 2 * 40);
    expect(layout.hasMeasured("r2")).toBe(true);
    expect(layout.hasMeasured("old0")).toBe(false);
  });

  it("finds the row at an offset and the window with overscan", () => {
    const layout = new RowLayout();
    layout.setRows(rows(100, 50));
    expect(layout.indexAt(0)).toBe(0);
    expect(layout.indexAt(49)).toBe(0);
    expect(layout.indexAt(50)).toBe(1);
    expect(layout.indexAt(-10)).toBe(0);
    expect(layout.indexAt(1e9)).toBe(99);
    // A 600px viewport at 2000px, one screen of overscan each way: rows
    // from 1400px to 3200px.
    expect(layout.range(2000, 600, 600)).toEqual({ start: 28, end: 65 });
    expect(layout.range(0, 600, 600)).toEqual({ start: 0, end: 25 });
    expect(layout.range(4800, 600, 600)).toEqual({ start: 84, end: 100 });
    expect(new RowLayout().range(0, 600, 600)).toEqual({ start: 0, end: 0 });
  });

  it("anchors the reader's row across a prepend and across measurement above", () => {
    const layout = new RowLayout();
    layout.setRows(rows(50, 40));
    // Reading row 20, 12px into it.
    const anchor = layout.anchorAt(20 * 40 + 12);
    expect(anchor).toEqual({ key: "r20", offset: 12 });
    // 150 older rows land above (their heights are estimates for now).
    layout.setRows([...rows(150, 30, "old"), ...rows(50, 40)]);
    expect(layout.scrollTopFor(anchor!)).toBe(150 * 30 + 20 * 40 + 12);
    // Measuring an older row taller shifts the reader's offset by the growth;
    // measuring a row below them shifts nothing.
    const anchorIndex = layout.indexOf("r20");
    const above = layout.measure("old3", 130)!;
    const below = layout.measure("r40", 200)!;
    expect(anchorShift([above, below], anchorIndex)).toBe(100);
    expect(anchorShift([layout.measure("r20", 60)!], anchorIndex)).toBe(0);
    // A row that is gone has no place to return to.
    expect(layout.scrollTopFor({ key: "nope", offset: 0 })).toBeNull();
  });

  it("knows when a mounted range still covers what the viewport needs", () => {
    expect(rangeCovers({ start: 10, end: 40 }, { start: 12, end: 38 })).toBe(true);
    expect(rangeCovers({ start: 10, end: 40 }, { start: 9, end: 38 })).toBe(false);
    expect(rangeCovers({ start: 10, end: 40 }, { start: 12, end: 41 })).toBe(false);
  });
});
