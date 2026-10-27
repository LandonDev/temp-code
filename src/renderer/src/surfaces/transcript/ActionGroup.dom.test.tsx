// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { Block } from "../../lib/session";
import { TranscriptSessionContext } from "../transcriptSession";
import { ActionGroup } from "./ActionGroup";

import { setEditorConfigForTest } from "../../lib/editorConfig";

// A row's file menu asks which editor opens files; there is no preload here.
beforeAll(() => setEditorConfigForTest(null));
// Unmount each render, so no scheduled React work outlives the jsdom environment.
afterEach(cleanup);

const CWD = "/r";
const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join("\n");
const tool = (id: string, name: string, input: unknown, extra: Partial<NonNullable<Block["tool"]>> = {}): Block => ({
  id,
  role: "tool",
  text: name,
  tool: { callId: id, name, title: name, status: "completed", input, ...extra },
});
const read = (id: string, path: string) => tool(id, "Read", { file_path: `${CWD}/${path}` }, { kind: "read" });
const bash = (id: string, command: string, extra: Partial<NonNullable<Block["tool"]>> = {}) =>
  tool(id, "Bash", { command }, { kind: "execute", ...extra });
const thought = (id: string): Block => ({ id, role: "reasoning", text: "Weighing the index.", ts: 1, doneTs: 4001 });
const five = (): Block[] => [
  read("a", "src/types.ts"),
  tool("b", "Write", { file_path: `${CWD}/diag.ts`, content: lines(46) }, { kind: "edit" }),
  bash("c", "npx convex dev --once"),
  tool("d", "Edit", { file_path: `${CWD}/schema.ts`, old_string: "x", new_string: lines(3) }, { kind: "edit" }),
  bash("e", "npm test"),
];

let sid = 0;
function mount(blocks: Block[], props: { live?: boolean } = {}, session = `s${++sid}`) {
  return render(
    <TranscriptSessionContext.Provider value={session}>
      <ActionGroup blocks={blocks} cwd={CWD} {...props} />
    </TranscriptSessionContext.Provider>,
  );
}
const trigger = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]');

describe("ActionGroup", () => {
  it("renders a lone call as its own row, no line above it", () => {
    const { container } = mount([read("a", "src/types.ts")]);
    expect(trigger(container)).toBeNull();
    expect(container.textContent).toContain("types.ts");
  });

  it("folds five actions into one closed line with the phrase and the summed counts", () => {
    const { container } = mount(five());
    const line = trigger(container)!;
    expect(line).not.toBeNull();
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(line.textContent).toContain("Read types.ts, created diag.ts, ran convex dev and 2 more");
    expect(line.textContent).toContain("+49");
    expect(line.textContent).toContain("−1");
    expect(container.querySelector("[data-kind]")?.getAttribute("data-kind")).toBe("edit");
  });

  it("leads with the dominant kind's glyph", () => {
    const { container } = mount([read("a", "a.ts"), read("b", "b.ts"), bash("c", "ls")]);
    expect(container.querySelector("[data-kind]")?.getAttribute("data-kind")).toBe("research");
  });

  it("opens on click and stays open across a remount of the same group", () => {
    const blocks = [read("a", "a.ts"), bash("b", "ls")];
    const first = mount(blocks, {}, "keep");
    act(() => {
      fireEvent.click(trigger(first.container)!);
    });
    expect(trigger(first.container)!.getAttribute("aria-expanded")).toBe("true");
    expect(first.container.querySelector(".divide-y")?.children.length).toBe(2);
    first.unmount();
    const again = mount(blocks, {}, "keep");
    expect(trigger(again.container)!.getAttribute("aria-expanded")).toBe("true");
  });

  it("stays closed while live, with the phrase shimmering in the present tense", () => {
    const { container } = mount([read("a", "a.ts"), bash("b", "npm test", { status: "running" })], { live: true });
    expect(trigger(container)!.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("Reading a.ts, running the tests");
  });

  it("is forced open while a step waits on the person", () => {
    const waiting: Block = { ...bash("b", "rm -rf build", { status: "pending" }), approval: { requestId: 1 } };
    const { container } = mount([read("a", "a.ts"), waiting]);
    expect(trigger(container)!.getAttribute("aria-expanded")).toBe("true");
  });

  it("marks failed calls with the failed glyph and their count", () => {
    const { container } = mount([read("a", "a.ts"), bash("b", "npm test", { status: "failed" })]);
    const mark = trigger(container)!.querySelector('[data-slot="status-mark"]')!;
    expect(mark.getAttribute("data-state")).toBe("failed");
    expect(mark.getAttribute("aria-label")).toBe("1 failed");
    expect(mark.textContent).toBe("1");
  });

  it("draws one call and the thought before it as two rows, no line and no box", () => {
    const { container } = mount([thought("t"), read("a", "src/types.ts")]);
    expect(container.querySelector("[data-kind]")).toBeNull();
    expect(container.querySelector(".divide-y")).toBeNull();
    expect(container.textContent).toContain("types.ts");
    // One row for the read (its glyph), nothing repeating it.
    expect(container.querySelectorAll("[data-glyph]").length).toBe(1);
    expect(container.textContent).toContain("Thought for 4s");
  });

  it("draws a run of thinking alone as the thinking row, never a line saying Thought", () => {
    const { container } = mount([thought("t")]);
    expect(container.querySelector("[data-kind]")).toBeNull();
    expect(container.textContent).toContain("Thought for 4s");
  });

  it("leads the line with the same glyph the run's first read draws on its row", () => {
    const { container } = mount([read("a", "a.ts"), read("b", "b.ts"), bash("c", "ls")]);
    const lineSvg = container.querySelector("[data-kind] svg")!.innerHTML;
    act(() => {
      fireEvent.click(trigger(container)!);
    });
    const rowSvg = container.querySelector(".divide-y [data-glyph] svg")!.innerHTML;
    expect(lineSvg).toBe(rowSvg);
  });

  it("never puts content-visibility or containment on the group", () => {
    const { container } = mount(five());
    act(() => {
      fireEvent.click(trigger(container)!);
    });
    for (const el of container.querySelectorAll<HTMLElement>("*")) {
      expect(el.style.contentVisibility).toBeFalsy();
      expect(el.style.contain).toBeFalsy();
      expect(el.className.toString()).not.toMatch(/content-visibility|contain-/);
    }
  });
});
