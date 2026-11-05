// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import type { Block } from "../../lib/session";
import { setEditorConfigForTest } from "../../lib/editorConfig";
import { ActionGroup } from "./ActionGroup";
import { reviewChunk } from "../chunks";
import { fixtures } from "./ActionGroup.fixtures";

// A row's file menu asks which editor opens files; there is no preload here.
beforeAll(() => setEditorConfigForTest(null));
// A gate's notice rides reviewChunk; landed, it renders at once.
beforeAll(() => reviewChunk.load());
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
  it("sits the list in a table, and every step line takes the table's 32px and 12px inset", () => {
    const { container } = mountFixture("Mixed calls, opened");
    expect(list(container).closest("[data-table]")).not.toBeNull();
    const steps = list(container).querySelectorAll(":scope > [data-step]");
    expect(steps.length).toBeGreaterThan(0);
    for (const row of steps) {
      const line = row.querySelector(".in-data-\\[table\\]\\:h-8, .in-data-\\[table\\]\\:min-h-8");
      expect(line, row.getAttribute("data-step") ?? "").not.toBeNull();
      expect(classes(line!)).toContain("in-data-[table]:px-3");
    }
  });

  it("draws a frame and rules for a group of two or more, and none for a lone call", () => {
    const { container } = mountFixture("Opened, three commands (the table)");
    const table = list(container).closest<HTMLElement>("[data-table]")!;
    expect(classes(table)).toEqual(expect.arrayContaining(["overflow-clip", "rounded-xl"]));
    const frame = table.querySelector("[data-table-frame]")!;
    expect(classes(frame)).toEqual(expect.arrayContaining(["absolute", "inset-0", "rounded-xl", "border", "border-border", "pointer-events-none"]));
    // Drawn after the list, so the list keeps its place among the children.
    expect(table.lastElementChild).toBe(frame);
    expect(classes(list(container))).toEqual(expect.arrayContaining(["divide-y", "divide-border"]));
    expect(list(container).querySelectorAll(":scope > [data-step]")).toHaveLength(3);
    // A group that mounts settled draws its frame at once.
    expect(classes(frame)).not.toContain("table-frame-in");
    cleanup();
    const lone = mountFixture("Lone read");
    expect(lone.container.querySelector("[data-table]")).toBeNull();
    expect(lone.container.querySelector("[data-table-frame]")).toBeNull();
  });

  it("opens a row's body flush in the table: no card of its own, under one hairline", () => {
    const { container } = mountFixture("Opened, mixed with a body open (the table)");
    const body = step(container, "body3").querySelector("[data-row-body]")!;
    expect(body).not.toBeNull();
    expect(classes(body)).toEqual(
      expect.arrayContaining(["in-data-[table]:rounded-none", "in-data-[table]:border-0", "in-data-[table]:border-t", "in-data-[table]:bg-transparent", "in-data-[table]:py-2"]),
    );
    expect(classes(body.parentElement!)).toContain("in-data-[table]:pb-0");
  });

  it("leads each call with the 14px glyph slot, verbs muted and targets in foreground", () => {
    const { container } = mountFixture("Mixed calls, opened");
    for (const id of ["mixed1", "mixed3", "mixed6"]) {
      const line = lineOf(step(container, id));
      expect(classes(line)).toEqual(expect.arrayContaining(["h-7", "in-data-[table]:h-8", "gap-1", "text-[13px]"]));
      const glyph = line.querySelector("[data-glyph]")!;
      // 8px to the verb: its own 4px on the line's 4px.
      expect(classes(glyph)).toEqual(expect.arrayContaining(["me-1", "size-3.5", "shrink-0"]));
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
    expect(classes(line)).toEqual(expect.arrayContaining(["min-h-7", "in-data-[table]:min-h-8"]));
    const lead = [...line.querySelectorAll("span")].find((el) => el.textContent === "Gate failed on")!;
    const branch = [...line.querySelectorAll("span")].find((el) => el.textContent === "port-the-view")!;
    expect(classes(lead)).toContain("text-muted-foreground");
    expect(classes(lead)).not.toContain("text-foreground");
    expect(classes(branch)).toContain("text-foreground");
  });

  it("keeps a lone call at the prose's edge, out of any table", () => {
    const { container } = mountFixture("Lone read");
    expect(list(container).closest("[data-table]")).toBeNull();
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

describe("the group line's glyph", () => {
  const call = (id: string, name: string, kind: string, input: unknown): Block => ({
    id,
    role: "tool",
    text: name,
    tool: { callId: id, name, kind, title: name, status: "completed", input },
  });
  const read = (id: string) => call(id, "Read", "read", { file_path: `/r/${id}.ts` });
  const edit = (id: string) => call(id, "Edit", "edit", { file_path: `/r/${id}.ts`, old_string: "a", new_string: "b" });

  it("swaps in place when the run's main kind changes: one glyph box, a new glyph in it", async () => {
    MotionGlobalConfig.skipAnimations = true;
    const view = render(<ActionGroup blocks={[read("a"), read("b")]} cwd="/r" />);
    const box = view.container.querySelector("[data-group-line] [data-kind]")!;
    expect(box.getAttribute("data-kind")).toBe("research");
    const before = box.querySelector("[data-swap]")?.getAttribute("data-swap");
    view.rerender(<ActionGroup blocks={[read("a"), read("b"), edit("c"), edit("d"), edit("e")]} cwd="/r" />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    MotionGlobalConfig.skipAnimations = false;
    const after = view.container.querySelector("[data-group-line] [data-kind]")!;
    expect(after).toBe(box);
    expect(after.getAttribute("data-kind")).not.toBe("research");
    expect(after.querySelectorAll("[data-swap]")).toHaveLength(1);
    expect(after.querySelector("[data-swap]")?.getAttribute("data-swap")).not.toBe(before);
  });
});

