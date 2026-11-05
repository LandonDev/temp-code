// @vitest-environment jsdom
/**
 * The open table growing as rows land: one height glide on the table box on
 * the layout spring, none when the window's pull-up nets the landing out or a
 * hand decides the commit, and the rows of one commit fading in staggered.
 * jsdom lays nothing out, so a row here is 32px and the table the sum of the
 * rows it holds less the window's pull-up.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setEditorConfigForTest } from "../../lib/editorConfig";
import type { Block } from "../../lib/session";
import { TranscriptSessionContext } from "../transcriptSession";
import { ActionGroup } from "./ActionGroup";

const ROW = 32;
const proto = HTMLElement.prototype;
const saved = {
  offsetHeight: Object.getOwnPropertyDescriptor(proto, "offsetHeight")!,
  offsetParent: Object.getOwnPropertyDescriptor(proto, "offsetParent")!,
  rect: proto.getBoundingClientRect,
};

/** The natural height jsdom would lay out: rows of 32px, the table their sum. */
function natural(el: HTMLElement): number {
  if (el.matches("[data-step]")) return ROW;
  if (el.matches("[data-table]")) {
    const list = el.querySelector<HTMLElement>("[data-group-rows]")!;
    const pull = parseFloat(list.style.marginTop) || 0;
    return list.querySelectorAll(":scope > [data-step]").length * ROW + pull;
  }
  return 0;
}

beforeAll(() => {
  setEditorConfigForTest(null);
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get: function (this: HTMLElement) { return natural(this); } });
  Object.defineProperty(proto, "offsetParent", { configurable: true, get: () => document.body });
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const inline = parseFloat(this.style.height);
    return { height: Number.isFinite(inline) ? inline : natural(this) } as DOMRect;
  };
});
afterAll(() => {
  Object.defineProperty(proto, "offsetHeight", saved.offsetHeight);
  Object.defineProperty(proto, "offsetParent", saved.offsetParent);
  proto.getBoundingClientRect = saved.rect;
});
afterEach(() => cleanup());

const call = (id: string, status = "completed"): Block => ({
  id,
  role: "tool",
  text: "Bash",
  tool: { callId: id, name: "Bash", kind: "execute", title: "Bash", status, input: { command: `bun test ${id}` } },
});
const done = (n: number) => Array.from({ length: n }, (_, i) => call(`c${i}`));
const running = (n: number) => [...done(n), call(`c${n}`, "running")];
const spawn = (id: string, status = "running"): Block => ({
  id,
  role: "tool",
  text: "spawn_agent",
  tool: { callId: id, name: "mcp__orchestrator__spawn_agent", title: "spawn_agent", status, input: { task: "Review the perf pass" } },
});

let sid = 0;
function mount(blocks: Block[], working: boolean) {
  const session = `g${++sid}`;
  const view = (b: Block[], w: boolean) => (
    <TranscriptSessionContext.Provider value={session}>
      <ActionGroup blocks={b} cwd="/r" live={w} working={w} settled={!w} />
    </TranscriptSessionContext.Provider>
  );
  const result = render(view(blocks, working));
  return { ...result, update: (b: Block[], w: boolean) => result.rerender(view(b, w)) };
}
const table = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-table]")!;
const step = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-step=${id}]`)!;
const gliding = (c: HTMLElement) => table(c).dataset.heightGlide !== undefined;
const click = (el: Element) =>
  act(() => {
    fireEvent.click(el);
  });

describe("the open table's height", () => {
  it("glides on the layout spring from the height it was drawn at when a row lands", () => {
    const { container, update } = mount(running(3), true);
    expect(gliding(container)).toBe(false);
    update(running(4), true);
    expect(gliding(container)).toBe(true);
    expect(table(container).style.transition).toBe("height var(--dur-layout) var(--ease-layout)");
    expect(table(container).style.height).toBe(`${4 * ROW}px`);
  });

  it("glides nothing when the window's pull-up nets a landing out", () => {
    const { container, update } = mount(running(5), true);
    update(running(6), true);
    // Six rows mounted, the oldest pulled up out of the frame: five rows' height either way.
    expect(container.querySelectorAll("[data-step]")).toHaveLength(6);
    expect(gliding(container)).toBe(false);
  });

  it("grows once for a burst: four rows into a table of three glide to the window's five", () => {
    const { container, update } = mount(running(3), true);
    update(running(7), true);
    expect(gliding(container)).toBe(true);
    expect(table(container).style.height).toBe(`${5 * ROW}px`);
  });

  it("glides nothing when a hand opens the group: the fold carries that", () => {
    const { container, update } = mount(done(2), false);
    update(done(4), false);
    click(container.querySelector("[data-group-line]")!);
    expect(container.querySelectorAll("[data-step]")).toHaveLength(4);
    expect(gliding(container)).toBe(false);
  });

  it("glides nothing when a row's body opens by hand", () => {
    const { container } = mount(running(3), true);
    click(step(container, "c1").querySelector("button")!);
    expect(gliding(container)).toBe(false);
  });
});

describe("rows landing in one commit", () => {
  it("fade in staggered: their place in the batch, the fourth and later at three steps", () => {
    const { container, update } = mount(running(2), true);
    update(running(7), true);
    const stagger = (id: string) => step(container, id).style.getPropertyValue("--stagger");
    expect(["c2", "c3", "c4", "c5", "c6"].map(stagger)).toEqual(["0", "1", "2", "3", "3"]);
    for (const id of ["c2", "c3", "c4", "c5", "c6"]) expect(step(container, id).className).toContain("step-land");
  });

  it("a row seen keeps its element and never takes .step-land, landing after landing", () => {
    const { container, update } = mount(running(2), true);
    const first = step(container, "c0");
    for (let n = 3; n <= 5; n++) {
      update(running(n), true);
      expect(step(container, "c0")).toBe(first);
      expect(first.className).not.toContain("step-land");
      expect(first.style.getPropertyValue("--stagger")).toBe("");
    }
  });

  it("a row keeps its element when its verb changes tense", () => {
    const { container, update } = mount([call("c0"), spawn("s0")], true);
    const row = step(container, "s0");
    update([call("c0"), spawn("s0", "completed"), call("c1", "running")], true);
    expect(step(container, "s0")).toBe(row);
    expect(row.className).not.toContain("step-land");
  });
});
