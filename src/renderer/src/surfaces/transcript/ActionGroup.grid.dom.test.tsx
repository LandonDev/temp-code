// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { Block } from "../../lib/session";
import { setEditorConfigForTest } from "../../lib/editorConfig";
import { ActionGroup } from "./ActionGroup";
import { fixtures } from "./ActionGroup.fixtures";

// A row's file menu asks which editor opens files; there is no preload here.
beforeAll(() => setEditorConfigForTest(null));
afterEach(cleanup);

/** The fixture renders with no session, opened through its ":a:<first id>" key. */
function mountFixture(name: string) {
  const fixture = fixtures.find((f) => f.name === name);
  if (!fixture) throw new Error(`no fixture ${name}`);
  return render(<ActionGroup {...fixture.props} />);
}

const list = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-group-rows]")!;
const step = (c: HTMLElement, id: string) => list(c).querySelector<HTMLElement>(`:scope > [data-step="${id}"]`)!;
/** A step's line: an action row's root, or a notice's inner line. */
const lineOf = (row: HTMLElement) =>
  row.querySelector<HTMLElement>(".group\\/action") ?? row.querySelector<HTMLElement>("[data-slot=notice-line] > div")!;
const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

describe("an open group's rows sit on one grid", () => {
  it("says the list is hung, and every step line takes the hung height", () => {
    const { container } = mountFixture("Mixed calls, opened");
    expect(list(container).hasAttribute("data-hung")).toBe(true);
    const steps = list(container).querySelectorAll(":scope > [data-step]");
    expect(steps.length).toBeGreaterThan(0);
    for (const row of steps) {
      const hung = row.querySelector(".in-data-\\[hung\\]\\:h-6\\.5, .in-data-\\[hung\\]\\:min-h-6\\.5");
      expect(hung, row.getAttribute("data-step") ?? "").not.toBeNull();
    }
  });

  it("leads each call with the 14px glyph slot, verbs muted and targets in foreground", () => {
    const { container } = mountFixture("Mixed calls, opened");
    for (const id of ["mixed1", "mixed3", "mixed6"]) {
      const line = lineOf(step(container, id));
      expect(classes(line)).toEqual(expect.arrayContaining(["h-7", "in-data-[hung]:h-6.5", "gap-2", "text-[13px]"]));
      const glyph = line.querySelector("[data-glyph]")!;
      expect(classes(glyph)).toEqual(expect.arrayContaining(["size-3.5", "shrink-0"]));
      // The glyph is the first thing drawn after the line's stretched button.
      const drawn = [...line.children].filter((el) => el.tagName !== "BUTTON" && !classes(el).includes("sr-only"));
      expect(drawn[0]).toBe(glyph);
    }
    const mcp = lineOf(step(container, "mixed6"));
    const verb = [...mcp.querySelectorAll(".text-muted-foreground")].find((el) => el.textContent === "Cosmic Admin");
    const target = [...mcp.querySelectorAll(".text-foreground")].find((el) => el.textContent === "Build get");
    expect(verb).toBeTruthy();
    expect(target).toBeTruthy();
  });

  it("leaves no empty slot before the chevron on a command row", () => {
    const { container } = mountFixture("Mixed calls, opened");
    const line = lineOf(step(container, "mixed2"));
    const trailing = [...line.children].find((el) => classes(el).includes("empty:hidden"));
    expect(trailing).toBeTruthy();
    expect(trailing!.childNodes.length).toBe(0);
  });

  it("reads a todo update as its verb with a muted tally and no target", () => {
    const { container } = mountFixture("Mixed calls, opened");
    const line = lineOf(step(container, "mixed5"));
    expect(line.textContent).toContain("Updated todos");
    const tally = [...line.querySelectorAll("span")].find((el) => el.textContent === "1/3")!;
    expect(classes(tally)).toEqual(expect.arrayContaining(["text-muted-foreground", "tabular-nums"]));
    expect(line.querySelector(".text-foreground.truncate")).toBeNull();
  });

  it("reads a folded gate as verb then target: the lead muted, the branch in foreground", () => {
    const { container } = mountFixture("Mixed calls, opened");
    const line = lineOf(step(container, "mixed8"));
    expect(classes(line)).toEqual(expect.arrayContaining(["min-h-7", "in-data-[hung]:min-h-6.5"]));
    const lead = [...line.querySelectorAll("span")].find((el) => el.textContent === "Gate failed")!;
    const branch = [...line.querySelectorAll("span")].find((el) => el.textContent === "port-the-view")!;
    expect(classes(lead)).toContain("text-muted-foreground");
    expect(classes(lead)).not.toContain("text-foreground");
    expect(classes(branch)).toContain("text-foreground");
  });

  it("keeps a lone call at the prose's edge, unhung", () => {
    const { container } = mountFixture("Lone read");
    expect(list(container).hasAttribute("data-hung")).toBe(false);
  });

  it("folds filler into the verb: a command with nothing to name reads its verb alone", () => {
    const blocks: Block[] = [
      { id: "f1", role: "tool", text: "Bash", tool: { callId: "f1", name: "Bash", kind: "execute", status: "completed", input: {} } },
      { id: "f2", role: "tool", text: "Read", tool: { callId: "f2", name: "Read", kind: "read", status: "completed", input: { file_path: "/r/a.ts" } } },
    ];
    const { container } = render(<ActionGroup blocks={blocks} cwd="/r" working />);
    const line = lineOf(step(container, "f1"));
    expect(line.textContent).toContain("Ran a command");
    expect(line.querySelector(".text-foreground.truncate")).toBeNull();
  });
});
