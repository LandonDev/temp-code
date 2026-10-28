import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { QueuedMessage } from "../lib/tcserver/types";

vi.mock("../lib/tcserver/store", () => ({ useSessionMeta: () => undefined }));
vi.mock("motion/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("motion/react")>();
  return { ...real, useReducedMotion: () => true };
});

const { MessageQueue, visibleQueue } = await import("./MessageQueue");

const item = (id: string, text: string, stored?: boolean): QueuedMessage => ({ id, text, ts: 1, ...(stored ? { stored } : {}) });
const noop = () => {};

describe("MessageQueue", () => {
  it("skips a stored item, the held-back boot's first message the transcript already shows", () => {
    expect(visibleQueue([item("a", "first", true), item("b", "second")]).map((m) => m.id)).toEqual(["b"]);
    render(<MessageQueue items={[item("a", "first", true), item("b", "second")]} onSteer={noop} onRemove={noop} onUpdate={noop} onReorder={noop} />);
    expect(screen.getByText("Queued").textContent).toBe("Queued1");
    expect(screen.getByRole("button", { name: "Edit: second" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit: first" })).toBeNull();
  });

  it("draws nothing when every item is stored", () => {
    const { container } = render(<MessageQueue items={[item("a", "first", true)]} onSteer={noop} onRemove={noop} onUpdate={noop} onReorder={noop} />);
    expect(container.innerHTML).toBe("");
  });
});
