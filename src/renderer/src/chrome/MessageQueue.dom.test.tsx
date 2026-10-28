import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
});
