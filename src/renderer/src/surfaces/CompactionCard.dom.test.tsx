// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../lib/session";
import { CompactionCard } from "./CompactionCard";
import { clockForTest } from "../lib/turnClock";

const pane = vi.hoisted(() => ({ visible: true }));
vi.mock("../hooks/paneVisibility", async (importOriginal) => ({ ...(await importOriginal<object>()), usePaneVisible: () => pane.visible }));

const block = (compaction: Block["compaction"]): Block => ({ id: "c", role: "system", text: "", compaction });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CompactionCard", () => {
  it("running in a hidden pane holds no clock", () => {
    pane.visible = false;
    try {
      render(<CompactionCard block={block({ phase: "start", startedAt: Date.now() - 3_000 })} />);
      expect(clockForTest.listeners()).toBe(0);
    } finally {
      pane.visible = true;
    }
    cleanup();
    render(<CompactionCard block={block({ phase: "start", startedAt: Date.now() - 3_000 })} />);
    expect(clockForTest.listeners()).toBe(1);
  });

  it("running: a spinner and Compacting context, no bar", () => {
    const { container } = render(<CompactionCard block={block({ phase: "start", startedAt: Date.now() - 3_000 })} />);
    expect(screen.getByRole("status", { name: "Compacting context" })).toBeTruthy();
    expect(container.querySelector('[data-slot="spinner"]')).not.toBeNull();
    expect(container.textContent).toContain("Compacting context");
  });

  it("done: Context compacted with the before and after and the time", () => {
    const { container } = render(
      <CompactionCard block={block({ phase: "done", preTokens: 48_000, postTokens: 12_000, durationMs: 6_000, trigger: "auto" })} />,
    );
    // The words and their details morph as one, inside the line's lead.
    const spans = [...container.querySelectorAll('[data-morph-key="done"] > span > span')].map((s) => s.textContent);
    expect(spans[0]).toBe("Context compacted");
    expect(spans[1]).toMatch(/→/);
    expect(spans[2]).toBe("6s");
    expect(container.textContent).not.toContain("auto");
    expect(container.querySelector('[role="separator"]')).toBeNull();
  });

  it("failed: the failed glyph and the error", () => {
    const { container } = render(<CompactionCard block={block({ phase: "failed", error: "window too small" })} />);
    expect(container.querySelector('[data-state="failed"]')).not.toBeNull();
    expect(container.textContent).toBe("Compaction failedwindow too small");
  });

  it("running: the time counts from the start and keeps counting across a re-render with the same start", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-11-01T12:00:00Z").getTime();
    vi.setSystemTime(t0 + 42_000);
    const meta = { phase: "start" as const, startedAt: t0 };
    const { container, rerender } = render(<CompactionCard block={block(meta)} />);
    expect(container.textContent).toBe("Compacting context42s");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    rerender(<CompactionCard block={block({ ...meta })} />);
    expect(container.textContent).toBe("Compacting context1m 12s");
  });

  it("stopped: the stopped glyph and the span, no spinner and no live status", () => {
    const { container } = render(<CompactionCard block={block({ phase: "stopped", startedAt: 1_000, endedAt: 90_000 })} />);
    expect(container.querySelector('[data-state="stopped"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="spinner"]')).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(container.textContent).toBe("Compaction stopped1m 29s");
  });
});

describe("CompactionCard from start to its outcome", () => {
  it("keeps one line: the glyph swaps and the words morph in place", async () => {
    MotionGlobalConfig.skipAnimations = true;
    const view = render(<CompactionCard block={block({ phase: "start", startedAt: Date.now() - 5_000 })} />);
    const line = view.container.querySelector('[data-slot="notice-line"]');
    expect(view.container.querySelector("[data-morph-key]")?.getAttribute("data-morph-key")).toBe("start");
    view.rerender(<CompactionCard block={block({ phase: "done", preTokens: 48_000, postTokens: 12_000, durationMs: 6_000 })} />);
    expect(view.container.querySelector('[data-slot="notice-line"]')).toBe(line);
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(view.container.querySelector("[data-morph-key]")?.getAttribute("data-morph-key")).toBe("done");
    expect(view.container.querySelector('[data-slot="notice-line"]')).toBe(line);
    MotionGlobalConfig.skipAnimations = false;
  });
});
