// @vitest-environment jsdom
/**
 * The working group: open on its own at two calls while the turn works in
 * it, the newest five rows, a landing row rising in, the fold a beat after
 * the work moves on, and a person's hand deciding from then on.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FOLD_HOLD_MS } from "../../lib/ease";
import { setEditorConfigForTest } from "../../lib/editorConfig";
import type { Block } from "../../lib/session";
import { GROUP_WINDOW } from "../transcriptRows";
import { TranscriptSessionContext } from "../transcriptSession";
import { ActionGroup } from "./ActionGroup";

beforeAll(() => setEditorConfigForTest(null));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const call = (id: string, status = "completed"): Block => ({
  id,
  role: "tool",
  text: "Bash",
  tool: { callId: id, name: "Bash", kind: "execute", title: "Bash", status, input: { command: `bun test ${id}` } },
});
const calls = (n: number, prefix = "c") => Array.from({ length: n }, (_, i) => call(`${prefix}${i}`, i === n - 1 ? "running" : "completed"));

let sid = 0;
function mount(blocks: Block[], working: boolean) {
  const session = `w${++sid}`;
  const view = (b: Block[], w: boolean) => (
    <TranscriptSessionContext.Provider value={session}>
      <ActionGroup blocks={b} cwd="/r" live={w} working={w} />
    </TranscriptSessionContext.Provider>
  );
  const result = render(view(blocks, working));
  return { ...result, update: (b: Block[], w: boolean) => result.rerender(view(b, w)) };
}
const line = (c: HTMLElement) => c.querySelector<HTMLButtonElement>("[data-group-line]")!;
const lineShown = (c: HTMLElement) => !line(c).closest("[hidden]");
const isOpen = (c: HTMLElement) => line(c).getAttribute("aria-expanded") === "true";
const steps = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>("[data-step]")];
const rowsPanel = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-group-rows]")!.parentElement as HTMLElement;
const click = (el: Element) =>
  act(() => {
    fireEvent.click(el);
  });

describe("the working group", () => {
  it("keeps the first row's node when the second call lands, and opens there with its line", () => {
    const { container, update } = mount(calls(1), true);
    expect(lineShown(container)).toBe(false);
    const first = container.querySelector("[data-step=c0]");
    update([call("c0"), call("c1", "running")], true);
    expect(container.querySelector("[data-step=c0]")).toBe(first);
    expect(lineShown(container)).toBe(true);
    expect(isOpen(container)).toBe(true);
    // No box: the rows hang 22px under the line's words.
    expect(container.querySelector("[data-group-rows]")!.className).toContain("pl-5.5");
    expect(container.querySelector(".border")).toBeNull();
  });

  it("shows its newest five rows while it runs on its own, and every row once opened by hand", () => {
    const { container } = mount(calls(9), true);
    expect(steps(container).map((el) => el.dataset.step)).toEqual(["c4", "c5", "c6", "c7", "c8"]);
    expect(GROUP_WINDOW).toBe(5);
    // The line still names them all.
    expect(line(container).textContent).toMatch(/9|and \d more/);
    // Opening a row's body is a hand on the group: it shows every row from then on.
    click(container.querySelector("[data-step=c5] button")!);
    expect(steps(container)).toHaveLength(9);
  });

  it("moves its window as rows land: the oldest leaves the top", () => {
    const { container, update } = mount(calls(5), true);
    expect(steps(container)).toHaveLength(5);
    update([...calls(5).map((b) => ({ ...b, tool: { ...b.tool!, status: "completed" } })), call("c5", "running")], true);
    // jsdom measures 0px, so the glide ends at once and the leaving row unmounts.
    expect(steps(container).map((el) => el.dataset.step)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
  });

  it("lands a new row with .step-land, never a row there at mount", () => {
    const { container, update } = mount(calls(2), true);
    update([...calls(2), call("c2", "running")], true);
    const cls = (id: string) => container.querySelector<HTMLElement>(`[data-step=${id}]`)!.className;
    expect(cls("c0")).not.toContain("step-land");
    expect(cls("c1")).not.toContain("step-land");
    expect(cls("c2")).toContain("step-land");
  });

  it("does not raise rows a hand open reveals", () => {
    const { container, update } = mount(calls(2), false);
    expect(isOpen(container)).toBe(false);
    update([...calls(2), call("c2")], false);
    click(line(container));
    expect(isOpen(container)).toBe(true);
    for (const el of steps(container)) expect(el.className).not.toContain("step-land");
  });

  it("folds FOLD_HOLD_MS after the work moves on, and not before", () => {
    vi.useFakeTimers();
    const { container, update } = mount(calls(2), true);
    expect(isOpen(container)).toBe(true);
    update(calls(2), false);
    // The frame the work moves on never starts the fold.
    expect(isOpen(container)).toBe(true);
    act(() => vi.advanceTimersByTime(FOLD_HOLD_MS - 1));
    expect(isOpen(container)).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(isOpen(container)).toBe(false);
  });

  it("keeps a hand's choice through the settle: closed by hand stays closed, a row body opened keeps it open", () => {
    vi.useFakeTimers();
    const closed = mount(calls(3), true);
    click(line(closed.container));
    expect(isOpen(closed.container)).toBe(false);
    closed.update(calls(3), false);
    act(() => vi.advanceTimersByTime(FOLD_HOLD_MS * 2));
    expect(isOpen(closed.container)).toBe(false);
    cleanup();
    const opened = mount(calls(3), true);
    click(opened.container.querySelector("[data-step=c0] button")!);
    opened.update(calls(3), false);
    act(() => vi.advanceTimersByTime(FOLD_HOLD_MS * 2));
    expect(isOpen(opened.container)).toBe(true);
  });

  it("stays open while a step inside waits on the person, settled or not", () => {
    vi.useFakeTimers();
    const waiting: Block = { ...call("c1", "pending"), approval: { requestId: 1 } };
    const { container, update } = mount([call("c0"), waiting], true);
    update([call("c0"), waiting], false);
    act(() => vi.advanceTimersByTime(FOLD_HOLD_MS * 2));
    expect(isOpen(container)).toBe(true);
  });

  it("mounted working shows open with no entrance; mounted settled shows closed", () => {
    const working = mount(calls(3), true);
    expect(isOpen(working.container)).toBe(true);
    expect(rowsPanel(working.container).hasAttribute("data-starting-style")).toBe(false);
    cleanup();
    const settled = mount(calls(3), false);
    expect(isOpen(settled.container)).toBe(false);
    expect(settled.container.querySelector("[data-group-rows]")).toBeNull();
  });

  it("folds on .collapsible-auto only while it runs on its own", () => {
    const { container } = mount(calls(3), true);
    expect(rowsPanel(container).className).toContain("collapsible-auto");
    click(line(container));
    click(line(container));
    expect(isOpen(container)).toBe(true);
    expect(rowsPanel(container).className).not.toContain("collapsible-auto");
  });
});
