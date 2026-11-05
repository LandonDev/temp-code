import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueuedMessage } from "../lib/tcserver/types";

vi.mock("../lib/tcserver/store", () => ({ useSessionMeta: () => undefined }));
vi.mock("motion/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("motion/react")>();
  return { ...real, useReducedMotion: () => true };
});

const { MessageQueue, mergeOrder, visibleQueue } = await import("./MessageQueue");

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
});
