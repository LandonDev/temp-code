import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FADE_IN, reveal, yields, type RevealGroup } from "./reveal";

const GROUPS: RevealGroup[] = ["", "body", "code", "details", "dock-tab", "html-render", "hunk", "item", "message", "model", "notice", "output", "q", "row", "turnend"];

/** `group-hover/q` for a named group, `group-hover` for the unnamed one. */
const v = (variant: string, group: string) => (group ? `${variant}/${group}` : variant);

describe("the hover reveal recipe", () => {
  it("waits --delay-hover on its group's hover and fades over --dur-fast on a wrapper", () => {
    const { container } = render(
      <div className="group/q">
        <span data-reveal className={reveal("q")}>
          <button type="button">Remove</button>
        </span>
      </div>,
    );
    const cls = container.querySelector("[data-reveal]")!.className;
    expect(cls).toContain("opacity-0");
    expect(cls).toContain("transition-opacity");
    expect(cls).toContain("duration-(--dur-fast)");
    expect(cls).toContain("ease-(--ease-out)");
    expect(cls).toContain("starting:opacity-0");
    expect(cls).toContain("group-hover/q:opacity-100");
    expect(cls).toContain("group-hover/q:delay-(--delay-hover)");
    // The button under it keeps its own classes: the fade is the wrapper's.
    expect(container.querySelector("button")!.className).toBe("");
  });

  it("shows at once on keyboard focus and while a menu inside is open, never on a click's focus", () => {
    const cls = reveal("item");
    expect(cls).toContain("has-focus-visible:opacity-100");
    expect(cls).toContain("has-focus-visible:delay-(--dur-instant)");
    expect(cls).toContain("has-[[data-popup-open]]:opacity-100");
    expect(cls).toContain("has-[[data-popup-open]]:delay-(--dur-instant)");
    expect(cls).not.toContain("focus-within");
  });

  it("keeps the fade under reduced motion", () => {
    expect(reveal("row")).toContain("motion-reduce:transition-opacity");
    expect(reveal("row")).not.toContain("motion-reduce:transition-none");
    expect(yields("row")).toContain("motion-reduce:transition-opacity");
    expect(FADE_IN).toContain("motion-reduce:transition-opacity");
  });

  it("every group's variants are in index.css's @source inline lists, so the stylesheet has them", () => {
    const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");
    const lists = css.match(/@source inline\("[^"]*"\)/g) ?? [];
    const hover = lists.find((l) => l.includes("group-hover{,/body"))!;
    for (const group of GROUPS) expect(hover).toMatch(group ? new RegExp(`/${group}[,}]`) : /\{,/);
    expect(hover).toContain(":{opacity-100,delay-(--delay-hover)}");
    const row = lists.find((l) => l.includes("{focus-visible,has-focus-visible}"))!;
    for (const group of ["dock-tab", "hunk", "item", "row"]) expect(row).toMatch(new RegExp(`/${group}[,}]`));
    const yieldList = lists.find((l) => l.includes("has-[[data-popup-open]]}"))!;
    expect(yieldList).toContain("{,/row}:{opacity-0,delay-(--dur-instant)}");
    expect(lists.some((l) => l.includes("group-hover{,/row}:{pointer-events-auto,opacity-0}"))).toBe(true);
  });

  it("a row reveal also answers keyboard focus on the row or anywhere in it", () => {
    for (const group of ["", "dock-tab", "hunk", "item", "row"] as const) {
      const cls = reveal(group, { row: true });
      expect(cls).toContain(`${v("group-focus-visible", group)}:opacity-100`);
      expect(cls).toContain(`${v("group-has-focus-visible", group)}:opacity-100`);
      expect(cls).toContain(`${v("group-has-focus-visible", group)}:delay-(--dur-instant)`);
    }
    expect(reveal("row")).not.toContain("group-has-focus-visible");
  });

  it("an overlay takes no pointer until its group is hovered", () => {
    const cls = reveal("row", { row: true, overlay: true });
    expect(cls).toContain("pointer-events-none");
    expect(cls).toContain("group-hover/row:pointer-events-auto");
    expect(reveal("row")).not.toContain("pointer-events-none");
  });

  it("what yields crosses over on the reveal's own timing", () => {
    for (const group of ["", "row"] as const) {
      const cls = yields(group);
      expect(cls).toContain(`${v("group-hover", group)}:opacity-0`);
      expect(cls).toContain(`${v("group-hover", group)}:delay-(--delay-hover)`);
      expect(cls).toContain(`${v("group-focus-visible", group)}:opacity-0`);
      expect(cls).toContain(`${v("group-has-focus-visible", group)}:delay-(--dur-instant)`);
      expect(cls).toContain("duration-(--dur-fast)");
      expect(cls).not.toContain("focus-within");
    }
  });

  it("FADE_IN fades an arriving control in from @starting-style", () => {
    expect(FADE_IN).toContain("starting:opacity-0");
    expect(FADE_IN).toContain("duration-(--dur-fast)");
    // Shown at rest: only its entry starts from nothing.
    expect(FADE_IN).not.toMatch(/(^|\s)opacity-0\b/);
  });
});
