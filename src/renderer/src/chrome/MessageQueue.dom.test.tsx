import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueuedMessage } from "../lib/tcserver/types";

vi.mock("../lib/tcserver/store", () => ({ useSessionMeta: () => undefined }));
const motionState = vi.hoisted(() => ({ reduce: true }));
vi.mock("motion/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("motion/react")>();
  return {
    ...real,
    useReducedMotion: () => motionState.reduce,
    // A drop's glide lands at once, so a test reads where it ends; the call keeps its spring.
    animate: vi.fn((_from: number, to: number, options: { onUpdate?: (v: number) => void; onComplete?: () => void }) => {
      options.onUpdate?.(to);
      options.onComplete?.();
      return { stop: vi.fn() };
    }),
  };
});
const { animate } = await import("motion/react");
const { SPRING_GLIDE } = await import("../lib/ease");

const { MessageQueue, droppedOrder, mergeOrder, visibleQueue } = await import("./MessageQueue");
// The tune button's popover is drawn by its parts (components/ui/lazy-menus.tsx): warm its body first.
const { menuChunk } = await import("../surfaces/chunks");
const { warmMenus } = await import("./menuRows");
await menuChunk.load();
warmMenus();

const item = (id: string, text: string, stored?: boolean): QueuedMessage => ({ id, text, ts: 1, ...(stored ? { stored } : {}) });
const noop = () => {};

describe("MessageQueue", () => {
  afterEach(cleanup);
  it.each([["xhigh", "Extra high"], ["ultra", "Ultra"]])("uses the shared effort word for %s", (reasoning, word) => {
    const { container, unmount } = render(<MessageQueue sessionId="s" items={[{ ...item("model", "follow up"), reasoning }]} onSteer={noop} onRemove={noop} onUpdate={noop} onReorder={noop} />);
    expect(container.querySelector('[aria-label="Model for this message"]')?.textContent).toContain(word);
    unmount();
  });

  it("on a queued thread, skips a stored item, the held-back boot's first message the transcript already shows", () => {
    expect(visibleQueue([item("a", "first", true), item("b", "second")], true).map((m) => m.id)).toEqual(["b"]);
    expect(visibleQueue([item("a", "first", true), item("b", "second")], false).map((m) => m.id)).toEqual(["a", "b"]);
    render(<MessageQueue items={[item("a", "first", true), item("b", "second")]} queued onSteer={noop} onRemove={noop} onUpdate={noop} onReorder={noop} />);
    expect(screen.getByText("Queued").textContent).toBe("Queued1");
    expect(screen.getByRole("button", { name: "Edit: second" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit: first" })).toBeNull();
  });

  it("draws nothing when every item is stored on a queued thread; elsewhere a stored item keeps its row and controls", () => {
    const { container, unmount } = render(<MessageQueue items={[item("a", "first", true)]} queued onSteer={noop} onRemove={noop} onUpdate={noop} onReorder={noop} />);
    expect(container.innerHTML).toBe("");
    unmount();
    render(<MessageQueue items={[item("a", "first", true)]} onSteer={noop} onRemove={noop} onUpdate={noop} onReorder={noop} />);
    expect(screen.getByRole("button", { name: "Edit: first" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Remove from queue" }).length).toBeGreaterThan(0);
  });

  it("a reorder of the shown rows keeps a hidden item where it was", () => {
    const items = [item("first", "task", true), item("a", "A"), item("b", "B")];
    expect(mergeOrder(items, ["b", "a"])).toEqual(["first", "b", "a"]);
    expect(mergeOrder([item("a", "A"), item("first", "task", true), item("b", "B")], ["b", "a"])).toEqual(["b", "first", "a"]);
    expect(mergeOrder(items, ["a", "b"])).toEqual(["first", "a", "b"]);
  });
  it("queue actions and the tune button reveal on the shared hover recipe", () => {
    render(<MessageQueue sessionId="s1" items={[item("a", "first")]} onSteer={noop} onRemove={noop} onUpdate={noop} onReorder={noop} />);
    const actions = screen.getByRole("button", { name: "Remove from queue" }).parentElement!.className;
    expect(actions).toContain("group-hover/q:delay-(--delay-hover)");
    expect(actions).toContain("has-focus-visible:opacity-100");
    expect(actions).toContain("motion-reduce:transition-opacity");
    // A click holds nothing up.
    expect(actions).not.toContain("focus-within");
    const tune = screen.getByRole("button", { name: "Model for this message" });
    const wrapper = tune.parentElement!;
    expect(wrapper.className).toContain("group-hover/q:delay-(--delay-hover)");
    expect(wrapper.className).toContain("has-[[data-popup-open]]:opacity-100");
    expect(tune.className).not.toContain("opacity-0");
    // Its popover open marks the trigger, which holds the wrapper shown.
    fireEvent.click(tune);
    expect(wrapper.querySelector("[data-popup-open]")).not.toBeNull();
  });

  it("a tuned message shows its settings at rest, outside the reveal", () => {
    render(<MessageQueue sessionId="s1" items={[{ ...item("a", "first"), provider: "claude", model: "claude-opus-5-5" }]} onSteer={noop} onRemove={noop} onUpdate={noop} onReorder={noop} />);
    expect(screen.getByRole("button", { name: "Model for this message" }).parentElement!.className).not.toContain("opacity-0");
  });

  it("sets the count 4px after Queued and each row's number 4px before its text", () => {
    render(<MessageQueue items={[item("a", "first"), item("b", "second")]} onSteer={noop} onRemove={noop} onUpdate={noop} onReorder={noop} />);
    expect(screen.getByText("Queued").querySelector("span")!.className.split(" ")).toContain("ms-1");
    const number = screen.getByRole("button", { name: "Edit: second" }).querySelector(".tabular-nums")!;
    expect(number.textContent).toBe("2");
    expect(number.className.split(" ")).toContain("me-1");
  });

  it("an arriving row enters on a full transform string; under reduced motion it only fades", () => {
    motionState.reduce = false;
    const view = render(<MessageQueue items={[item("a", "first")]} onSteer={noop} onRemove={noop} onUpdate={noop} onReorder={noop} />);
    view.rerender(<MessageQueue items={[item("a", "first"), item("b", "second")]} onSteer={noop} onRemove={noop} onUpdate={noop} onReorder={noop} />);
    const arrived = document.querySelector<HTMLElement>('[data-queue-row="b"]')!;
    expect(arrived.style.transform).toContain("translateY(4px)");
    expect(arrived.style.opacity).toBe("0");
    view.unmount();
    motionState.reduce = true;
    const reduced = render(<MessageQueue items={[item("a", "first")]} onSteer={noop} onRemove={noop} onUpdate={noop} onReorder={noop} />);
    reduced.rerender(<MessageQueue items={[item("a", "first"), item("b", "second")]} onSteer={noop} onRemove={noop} onUpdate={noop} onReorder={noop} />);
    const faded = document.querySelector<HTMLElement>('[data-queue-row="b"]')!;
    expect(faded.style.transform).toBe("");
    expect(faded.style.opacity).toBe("0");
  });

  it("a dropped order shows at once, made against the rows as they are; the host's next order wins", () => {
    const rows = [item("a", "A"), item("b", "B")];
    expect(droppedOrder(rows, { base: "a\u0000b", order: ["b", "a"] }).map((m) => m.id)).toEqual(["b", "a"]);
    expect(droppedOrder(rows, { base: "x\u0000y", order: ["b", "a"] }).map((m) => m.id)).toEqual(["a", "b"]);
    expect(droppedOrder(rows, null).map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("MessageQueue reorder", () => {
  // jsdom has no pointer capture.
  HTMLElement.prototype.setPointerCapture ??= () => {};
  HTMLElement.prototype.releasePointerCapture ??= () => {};
  const row = (id: string) => document.querySelector<HTMLElement>(`[data-queue-row="${id}"]`)!;
  const grip = (id: string) => row(id).querySelector<HTMLElement>("[data-queue-grip]")!;
  const order = () => [...document.querySelectorAll<HTMLElement>("[data-queue-row]")].map((el) => el.dataset.queueRow);

  /** Each row 40px tall in its column, its `translate` added, as a browser draws it. */
  function layOut() {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const index = this.dataset.queueRow ? [...this.parentElement!.children].indexOf(this) : 0;
      const y = parseFloat((this.style.translate || "0px 0px").split(" ")[1]!) || 0;
      const top = index * 40 + y;
      return { left: 0, right: 300, width: 300, top, bottom: top + 40, height: 40, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
  }

  afterEach(() => {
    cleanup();
    vi.mocked(animate).mockClear();
    vi.restoreAllMocks();
  });

  const three = [item("a", "A"), item("b", "B"), item("c", "C")];

  it("a drag by the grip moves the dragged row alone, the others hold with the insertion line, and the drop shows the new order", () => {
    layOut();
    const onReorder = vi.fn();
    render(<MessageQueue items={three} onSteer={noop} onRemove={noop} onUpdate={noop} onReorder={onReorder} />);
    fireEvent.pointerDown(grip("a"), { button: 0, pointerId: 1, clientX: 10, clientY: 20 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: 45 });
    expect(row("a").style.translate).toBe("0px 25px");
    expect(row("b").style.translate).toBe("");
    expect(row("c").style.translate).toBe("");
    // a, drawn at 25..65, sits before b's middle at 60: the line marks the bottom of b.
    const line = row("b").querySelector<HTMLElement>("[data-queue-drop]")!;
    expect(line.className).toContain("bottom-0");
    expect(document.querySelectorAll("[data-queue-drop]")).toHaveLength(1);
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 10, clientY: 45 });
    });
    expect(onReorder).toHaveBeenCalledWith(["b", "a", "c"]);
    expect(order()).toEqual(["b", "a", "c"]);
    // Drawn at 25, its new slot at 40: it glides the last 15px down into it, on SPRING_GLIDE.
    const [from, to, options] = vi.mocked(animate).mock.calls.at(-1)! as unknown as [number, number, typeof SPRING_GLIDE];
    expect([from, to]).toEqual([-15, 0]);
    expect(options.stiffness).toBe(SPRING_GLIDE.stiffness);
    expect(document.querySelectorAll("[data-queue-drop]")).toHaveLength(0);
  });

  it("Escape glides the row back to its own slot and reorders nothing", () => {
    layOut();
    const onReorder = vi.fn();
    render(<MessageQueue items={three} onSteer={noop} onRemove={noop} onUpdate={noop} onReorder={onReorder} />);
    fireEvent.pointerDown(grip("a"), { button: 0, pointerId: 1, clientX: 10, clientY: 20 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: 70 });
    fireEvent.keyDown(window, { key: "Escape" });
    const [from, to, options] = vi.mocked(animate).mock.calls.at(-1)! as unknown as [number, number, typeof SPRING_GLIDE];
    expect([from, to]).toEqual([50, 0]);
    expect(options.damping).toBe(SPRING_GLIDE.damping);
    expect(row("a").style.translate).toBe("");
    expect(onReorder).not.toHaveBeenCalled();
    expect(order()).toEqual(["a", "b", "c"]);
  });

  it("the grip sits in the `+` button's 28px box, 6px in from the row's edge, on `+`'s axis", () => {
    render(<MessageQueue items={three} onSteer={noop} onRemove={noop} onUpdate={noop} onReorder={noop} />);
    const g = grip("a");
    expect(g.className.split(" ")).toEqual(expect.arrayContaining(["w-7", "justify-center"]));
    expect(g.className).not.toMatch(/(^|\s)-?ms-/);
    expect(g.parentElement!.className.split(" ")).toContain("pl-1.5");
    // The text starts 8px after the box, as the field's does (the row's gap-1 and the field's px-1).
    expect(g.parentElement!.className.split(" ")).toContain("gap-2");
    // The grip centres on the text's first 20px line, on the grid: no off-grid nudge.
    const line = g.querySelector("svg")!.parentElement!;
    expect(line.className.split(" ")).toEqual(expect.arrayContaining(["h-5", "items-center"]));
    expect(g.innerHTML).not.toContain("mt-[3px]");
  });

  it("a press on the text edits it; only the grip drags", () => {
    render(<MessageQueue items={three} onSteer={noop} onRemove={noop} onUpdate={noop} onReorder={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit: B" }));
    expect(screen.getByRole("textbox", { name: "Edit queued message" })).toBeTruthy();
  });
});
