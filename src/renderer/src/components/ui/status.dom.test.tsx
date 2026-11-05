// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { StatusMark, type ThreadState } from "./status";

// jsdom has no Web Animations; each turn is a cancellable handle.
const animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation);

const STATES: ThreadState[] = ["working", "waiting", "paused", "failed", "queued", "stopped", "watching", "plan-ready", "done", "idle"];

describe("StatusMark", () => {
  beforeEach(() => {
    Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });
    vi.stubGlobal("matchMedia", () => ({ matches: false }) as MediaQueryList);
  });
  afterEach(() => {
    cleanup();
    delete (Element.prototype as { animate?: unknown }).animate;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("draws working as a turning spinner", () => {
    const { container } = render(<StatusMark state="working" />);
    expect(container.querySelector("[data-slot=spinner][data-turning]")).not.toBeNull();
    expect(container.querySelector("[data-slot=working-dot]")).toBeNull();
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it("draws working as a still dot under a row that already moves, never an arc", () => {
    const { container } = render(<StatusMark state="working" still />);
    const dot = container.querySelector("[data-slot=working-dot]");
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("[data-slot=spinner]")).toBeNull();
    expect(container.querySelector("[role=status]")).toBeNull();
    expect(animate).not.toHaveBeenCalled();
    expect(container.querySelector("[data-slot=status-word]")?.textContent).toBe("Working");
  });

  it("still says Working when the dot stands alone", () => {
    const { container } = render(<StatusMark state="working" still word={false} />);
    expect(container.querySelector("[data-slot=status-mark]")?.getAttribute("aria-label")).toBe("Working");
  });

  it("draws the dot for working alone", () => {
    for (const state of STATES.filter((s) => s !== "working")) {
      const { container } = render(<StatusMark state={state} still />);
      expect(container.querySelector("[data-slot=working-dot]"), state).toBeNull();
      cleanup();
    }
  });

  it("pulls the detail 4px toward the word only, so a detail with no word lines up with its title", () => {
    const detail = (el: HTMLElement) => el.querySelector("[data-slot=status-detail]")!.className;
    const both = render(<StatusMark state="waiting" detail="Approve Bash" />);
    expect(detail(both.container)).toContain("-ms-1");
    cleanup();
    // Glyph then detail: the glyph's own 8px, as before a word.
    const glyphOnly = render(<StatusMark state="waiting" word={false} detail="Approve Bash" />);
    expect(detail(glyphOnly.container)).not.toContain("-ms-1");
    cleanup();
    // A board row's line: the detail alone starts at the row's edge.
    const bare = render(<StatusMark state="waiting" glyph={false} word={false} detail="Approve Bash" />);
    expect(detail(bare.container)).not.toContain("-ms-1");
  });
});
