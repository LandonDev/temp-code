// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Block } from "../lib/session";
import { CompactionCard } from "./CompactionCard";

const block = (compaction: Block["compaction"]): Block => ({ id: "c", role: "system", text: "", compaction });

afterEach(cleanup);

describe("CompactionCard", () => {
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
    const spans = [...container.querySelectorAll('[data-slot="notice-line"] > div > div > span')].map((s) => s.textContent);
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
});
