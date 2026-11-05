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
/** `n` settled calls, c0 to c(n-1). */
const done = (n: number) => Array.from({ length: n }, (_, i) => call(`c${i}`));
/** `n` settled calls and the running one after them, c(n). */
const running = (n: number) => [...done(n), call(`c${n}`, "running")];
const spawn = (id: string, status = "running"): Block => ({
  id,
  role: "tool",
  text: "spawn_agent",
  tool: { callId: id, name: "mcp__orchestrator__spawn_agent", title: "spawn_agent", status, input: { task: "Review the perf pass" } },
});

let sid = 0;
/** A group as the transcript mounts it: while it works its turn is open. */
function mount(blocks: Block[], working: boolean) {
  const session = `w${++sid}`;
  const view = (b: Block[], w: boolean) => (
    <TranscriptSessionContext.Provider value={session}>
      <ActionGroup blocks={b} cwd="/r" live={w} working={w} settled={!w} />
    </TranscriptSessionContext.Provider>
  );
  const result = render(view(blocks, working));
  return { ...result, update: (b: Block[], w: boolean) => result.rerender(view(b, w)) };
}
const line = (c: HTMLElement) => c.querySelector<HTMLButtonElement>("[data-group-line]")!;
const lineShown = (c: HTMLElement) => !line(c).closest("[hidden]");
const isOpen = (c: HTMLElement) => line(c).getAttribute("aria-expanded") === "true";
const steps = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>("[data-step]")];
const ids = (c: HTMLElement) => steps(c).map((el) => el.dataset.step);
const rowsPanel = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-group-rows]")!.parentElement!.parentElement as HTMLElement;
const frame = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-table-frame]");
const click = (el: Element) =>
  act(() => {
    fireEvent.click(el);
  });

describe("the working group", () => {
  it("keeps the first row's node when the second call starts, and opens there with its line", () => {
    const { container, update } = mount(done(1), true);
    expect(lineShown(container)).toBe(false);
    const first = container.querySelector("[data-step=c0]");
    update(running(1), true);
    expect(container.querySelector("[data-step=c0]")).toBe(first);
    expect(lineShown(container)).toBe(true);
    expect(isOpen(container)).toBe(true);
    // The running call is the working line's, not a row; the line names both.
    expect(ids(container)).toEqual(["c0"]);
    expect(line(container).textContent).toMatch(/2|running/i);
    // The rows sit in the table, its frame fading in while the lone row glides to the inset.
    expect(container.querySelector("[data-group-rows]")!.closest("[data-table]")).not.toBeNull();
    expect(frame(container)!.className).toContain("table-frame-in");
  });

  it("fades the table's frame in only on the lone-to-group glide, never at mount", async () => {
    const mounted = mount(running(2), true);
    expect(frame(mounted.container)!.className).not.toContain("table-frame-in");
    cleanup();
    const { container, update } = mount(done(1), true);
    expect(frame(container)).toBeNull();
    update(running(1), true);
    expect(frame(container)!.className).toContain("table-frame-in");
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)));
    expect(frame(container)!.className).not.toContain("table-frame-in");
  });

  it("draws nothing for one running call alone while its turn is open", () => {
    const { container } = mount([call("c0", "running")], true);
    expect(container.innerHTML).toBe("");
  });

  it("lands a running call as a row with .step-land once it settles, never a row there at mount", () => {
    const { container, update } = mount(running(2), true);
    expect(ids(container)).toEqual(["c0", "c1"]);
    update(running(3), true);
    const cls = (id: string) => container.querySelector<HTMLElement>(`[data-step=${id}]`)!.className;
    expect(ids(container)).toEqual(["c0", "c1", "c2"]);
    expect(cls("c0")).not.toContain("step-land");
    expect(cls("c1")).not.toContain("step-land");
    expect(cls("c2")).toContain("step-land");
  });

  it("keeps an agent call's row while it runs", () => {
    const { container } = mount([call("c0"), spawn("s0")], true);
    expect(ids(container)).toEqual(["c0", "s0"]);
  });

  it("draws a call still pending as a row once its turn is over", () => {
    const { container } = mount(running(1), false);
    click(line(container));
    expect(ids(container)).toEqual(["c0", "c1"]);
  });

  it("shows its newest five rows while it runs on its own, and every row once opened by hand", () => {
    const { container } = mount(running(9), true);
    expect(ids(container)).toEqual(["c4", "c5", "c6", "c7", "c8"]);
    expect(GROUP_WINDOW).toBe(5);
    // The line still names them all, the running one included.
    expect(line(container).textContent).toMatch(/10|and \d more/);
    // Opening a row's body is a hand on the group: it shows every row from then on.
    click(container.querySelector("[data-step=c5] button")!);
    expect(steps(container)).toHaveLength(9);
  });

  it("moves its window as rows land: the oldest leaves the top", () => {
    const { container, update } = mount(running(5), true);
    expect(ids(container)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
    update(running(6), true);
    // jsdom measures 0px, so the glide ends at once and the leaving row unmounts.
    expect(ids(container)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
  });

  it("glides the window on its own transition only, and drops the pull-up with the leaving row", () => {
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(28);
    const { container, update } = mount(running(5), true);
    update(running(6), true);
    const list = container.querySelector<HTMLElement>("[data-group-rows]")!;
    // The leaving row stays, clipped above, while the list glides up by its height.
    expect(steps(container)).toHaveLength(6);
    expect(list.style.marginTop).toBe("-28px");
    const ended = (target: Element, propertyName: string) =>
      act(() => {
        const event = new Event("transitionend", { bubbles: true });
        Object.defineProperty(event, "propertyName", { value: propertyName });
        target.dispatchEvent(event);
      });
    // A landing row's own transition bubbles up: the glide goes on.
    ended(container.querySelector("[data-step=c5]")!, "translate");
    expect(steps(container)).toHaveLength(6);
    // The list's glide ends: the row leaves and the pull-up with it, in one commit.
    ended(list, "transform");
    expect(ids(container)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    expect(list.style.marginTop).toBe("");
    height.mockRestore();
  });

  it("does not raise rows a hand open reveals", () => {
    const { container, update } = mount(done(2), false);
    expect(isOpen(container)).toBe(false);
    update(done(3), false);
    click(line(container));
    expect(isOpen(container)).toBe(true);
    for (const el of steps(container)) expect(el.className).not.toContain("step-land");
  });

  it("opens on its own at two calls, one running, and folds FOLD_HOLD_MS after the work moves on", () => {
    vi.useFakeTimers();
    const { container, update } = mount(running(1), true);
    expect(isOpen(container)).toBe(true);
    update(done(2), false);
    // The frame the work moves on never starts the fold; the settled call lands meanwhile.
    expect(isOpen(container)).toBe(true);
    expect(ids(container)).toEqual(["c0", "c1"]);
    act(() => vi.advanceTimersByTime(FOLD_HOLD_MS - 1));
    expect(isOpen(container)).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(isOpen(container)).toBe(false);
  });

  it("keeps a hand's choice through the settle: closed by hand stays closed, a row body opened keeps it open", () => {
    vi.useFakeTimers();
    const closed = mount(running(2), true);
    click(line(closed.container));
    expect(isOpen(closed.container)).toBe(false);
    closed.update(done(3), false);
    act(() => vi.advanceTimersByTime(FOLD_HOLD_MS * 2));
    expect(isOpen(closed.container)).toBe(false);
    cleanup();
    const opened = mount(running(2), true);
    click(opened.container.querySelector("[data-step=c0] button")!);
    opened.update(done(3), false);
    act(() => vi.advanceTimersByTime(FOLD_HOLD_MS * 2));
    expect(isOpen(opened.container)).toBe(true);
  });

  it("stays open while a step inside waits on the person, settled or not", () => {
    vi.useFakeTimers();
    const waiting: Block = { ...call("c1", "pending"), approval: { requestId: 1 } };
    const { container, update } = mount([call("c0"), waiting], true);
    expect(ids(container)).toEqual(["c0", "c1"]);
    update([call("c0"), waiting], false);
    act(() => vi.advanceTimersByTime(FOLD_HOLD_MS * 2));
    expect(isOpen(container)).toBe(true);
  });

  it("mounted working shows open with no entrance; mounted settled shows closed", () => {
    const working = mount(running(2), true);
    expect(isOpen(working.container)).toBe(true);
    expect(rowsPanel(working.container).hasAttribute("data-starting-style")).toBe(false);
    cleanup();
    const settled = mount(done(3), false);
    expect(isOpen(settled.container)).toBe(false);
    expect(settled.container.querySelector("[data-group-rows]")).toBeNull();
  });

  it("folds on .collapsible-auto only while it runs on its own", () => {
    const { container } = mount(running(2), true);
    expect(rowsPanel(container).className).toContain("collapsible-auto");
    click(line(container));
    click(line(container));
    expect(isOpen(container)).toBe(true);
    expect(rowsPanel(container).className).not.toContain("collapsible-auto");
  });
});
