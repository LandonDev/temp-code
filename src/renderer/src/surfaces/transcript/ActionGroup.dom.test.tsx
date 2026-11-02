// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { Block } from "../../lib/session";
import { TranscriptSessionContext } from "../transcriptSession";
import { ActionGroup } from "./ActionGroup";

import { setEditorConfigForTest } from "../../lib/editorConfig";

// The agent's thread is titled "A" wherever a call or a report names it.
vi.mock("../../lib/threadMentions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/threadMentions")>()),
  useTitlesOf: () => (id: string) => (id === "a" ? "A" : undefined),
}));

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
/** The group's line, when it shows: a lone call folds it away (kept mounted, hidden). */
const trigger = (c: HTMLElement) => {
  const line = c.querySelector<HTMLButtonElement>("[data-group-line]");
  return line && !line.closest("[hidden]") ? line : null;
};

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
    expect(first.container.querySelector("[data-group-rows]")?.children.length).toBe(2);
    first.unmount();
    const again = mount(blocks, {}, "keep");
    expect(trigger(again.container)!.getAttribute("aria-expanded")).toBe("true");
  });

  it("stays closed while live, with the phrase pulsing in the present tense", () => {
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

  it("draws one call and the thought before it as two rows, no line and no hang", () => {
    const { container } = mount([thought("t"), read("a", "src/types.ts")]);
    expect(trigger(container)).toBeNull();
    expect(container.querySelector("[data-group-rows]")!.className).not.toContain("pl-5.5");
    expect(container.textContent).toContain("types.ts");
    // One row for the read (its glyph), nothing repeating it.
    expect(container.querySelectorAll("[data-glyph]").length).toBe(1);
    expect(container.textContent).toContain("Thought for 4s");
  });

  it("draws a run of thinking alone as the thinking row, never a line saying Thought", () => {
    const { container } = mount([thought("t")]);
    expect(trigger(container)).toBeNull();
    expect(container.textContent).toContain("Thought for 4s");
  });

  it("leads the line with the same glyph the run's first read draws on its row", () => {
    const { container } = mount([read("a", "a.ts"), read("b", "b.ts"), bash("c", "ls")]);
    const lineSvg = container.querySelector("[data-kind] svg")!.innerHTML;
    act(() => {
      fireEvent.click(trigger(container)!);
    });
    const rowSvg = container.querySelector("[data-group-rows] [data-glyph] svg")!.innerHTML;
    expect(lineSvg).toBe(rowSvg);
  });

  describe("agent work and the host's steps", () => {
    const orch = (id: string, name: string, input: unknown, extra: Partial<NonNullable<Block["tool"]>> = {}) =>
      tool(id, `mcp__orchestrator__${name}`, input, extra);
    const report = (id: string, status = "done"): Block => ({ id, role: "system", text: "", agent: { id: "a", title: "A", status } });
    const gate = (ok: boolean): Block => ({
      id: `g${ok}`,
      role: "system",
      text: "",
      gate: { step: "gate", branch: "ui-3", ok, log: ok ? "" : "› vitest\ngate failed: vitest", at: 0 },
    });
    const open = (c: HTMLElement) =>
      act(() => {
        fireEvent.click(trigger(c)!);
      });

    it("a master's run reads as one line and opens onto its three rows, the report's state marked", () => {
      const { container } = mount([
        orch("s", "spawn_agent", { task: "x" }, { spawned: ["a"] }),
        orch("w", "wait_for_agent", { agentId: "a" }),
        report("r", "error"),
      ]);
      expect(trigger(container)!.textContent).toContain("Spawned “A”, waited for “A”, heard from “A”");
      expect(container.querySelector("[data-kind]")?.getAttribute("data-kind")).toBe("agents");
      open(container);
      const list = container.querySelector("[data-group-rows]")!;
      expect(list.children.length).toBe(3);
      expect(list.children[2].textContent).toContain("Heard from");
      expect(list.children[2].querySelector('[data-slot="status-mark"]')?.getAttribute("data-state")).toBe("failed");
    });

    it("a red gate counts on the line's figure and opens its log in place", () => {
      const { container } = mount([bash("b", "ls"), gate(false)]);
      const mark = trigger(container)!.querySelector('[data-slot="status-mark"]')!;
      expect(mark.textContent).toBe("1");
      open(container);
      const logTrigger = container.querySelector<HTMLButtonElement>('[data-group-rows] [data-slot="collapsible-trigger"]')!;
      act(() => {
        fireEvent.click(logTrigger);
      });
      expect(container.querySelector("[data-group-rows] pre")?.textContent).toContain("gate failed: vitest");
    });

    it("a todo update folds as a step, Updated todos 3/7, and opens its list", () => {
      const todos = Array.from({ length: 7 }, (_, i) => ({ content: `step ${i}`, status: i < 3 ? "completed" : "pending" }));
      const { container } = mount([bash("b", "ls"), tool("t", "TodoWrite", { todos })]);
      expect(trigger(container)!.textContent).toContain("updated todos");
      open(container);
      const row = container.querySelector("[data-group-rows]")!.children[1] as HTMLElement;
      expect(row.textContent).toContain("Updated todos");
      expect(row.textContent).toContain("3/7");
      act(() => {
        fireEvent.click(row.querySelector("button")!);
      });
      expect(row.textContent).toContain("step 6");
    });

    it("a lone report is its own line with no group", () => {
      const { container } = mount([report("r")]);
      expect(trigger(container)).toBeNull();
      expect(container.textContent).toContain("Heard from");
      expect(container.textContent).toContain("A");
    });
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
