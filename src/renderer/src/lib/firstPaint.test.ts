import { describe, expect, it } from "vitest";
import { FIRST_PAINT_MS, watchFirstPaint } from "./firstPaint";

function harness() {
  let clock = 0;
  const painted: (() => void)[] = [];
  const lines: string[] = [];
  const open = (armed?: boolean) =>
    watchFirstPaint("s1", "env_box", {
      ...(armed === undefined ? {} : { armed }),
      now: () => clock,
      afterPaint: (fn) => painted.push(fn),
      report: (line) => lines.push(line),
    });
  const paint = () => {
    for (const fn of painted.splice(0)) fn();
  };
  return { open, paint, lines, at: (ms: number) => (clock = ms) };
}

describe("watchFirstPaint", () => {
  it("reports once when the first rows paint later than half a second after the pane opened", () => {
    const h = harness();
    const watch = h.open();
    h.at(650);
    watch.rows();
    h.at(700);
    h.paint();
    watch.rows();
    h.paint();
    expect(h.lines).toEqual(["first-paint session=s1 host=env_box ms=700"]);
  });

  it("says nothing for a quick paint or a pane closed before its rows", () => {
    const h = harness();
    const quick = h.open();
    h.at(FIRST_PAINT_MS);
    quick.rows();
    h.paint();
    h.at(1_000);
    const closed = h.open();
    closed.dispose();
    h.at(5_000);
    closed.rows();
    h.paint();
    expect(h.lines).toEqual([]);
  });

  it("a draft never reports: its first rows arrive when the person sends", () => {
    const h = harness();
    const draft = h.open(false);
    h.at(30_000);
    draft.rows();
    h.paint();
    expect(h.lines).toEqual([]);
  });
});
