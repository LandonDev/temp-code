// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import type { Block } from "../../lib/session";
import { TranscriptSessionContext } from "../transcriptSession";
import { ActionGroup } from "./ActionGroup";

import { setEditorConfigForTest } from "../../lib/editorConfig";

// A row's file menu asks which editor opens files; there is no preload here.
beforeAll(() => setEditorConfigForTest(null));

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

  it("says how many calls failed, in its own figure", () => {
    const { container } = mount([read("a", "a.ts"), bash("b", "npm test", { status: "failed" })]);
    expect(trigger(container)!.textContent).toContain("1 failed");
    expect(trigger(container)!.textContent).not.toContain("(1 failed)");
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
