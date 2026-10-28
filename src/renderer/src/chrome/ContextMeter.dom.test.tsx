// @vitest-environment jsdom
/**
 * The composer's context meter: nothing without a window; the ring and the
 * percent, muted then amber from 85% (never red); the tokens on hover, or
 * Compacting with a spinner; the breakdown popover with its categories, its
 * two lists cut at six, a skeleton before the first reading and one line
 * mid-turn; Compact only when the thread can, which runs the handler.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextReading } from "../lib/contextCache";

const cache = vi.hoisted(() => ({ reading: null as ContextReading | null, live: [] as boolean[] }));
vi.mock("../lib/contextCache", () => ({
  useContextReading: (_id: string, live: boolean) => {
    cache.live.push(live);
    return cache.reading;
  },
}));

import { TooltipProvider, tooltipChunk, warmTooltips } from "../components/ui/tooltip";
import { menuChunk } from "../surfaces/chunks";
import { ContextBreakdown, ContextMeter } from "./ContextMeter";
import { warmMenus } from "./menuRows";

afterEach(() => {
  cleanup();
  cache.reading = null;
  cache.live = [];
});

const meter = () => screen.getByRole("button", { name: /^Context/ });

const READING: ContextReading = {
  totalTokens: 84_000,
  maxTokens: 200_000,
  percentage: 42,
  categories: [
    { name: "Messages", tokens: 52_000, color: "#ff0000" },
    { name: "System prompt", tokens: 3_100, color: "#00ff00" },
    { name: "Free space", tokens: 0 },
    { name: "System tools", tokens: 14_800 },
  ],
  memoryFiles: Array.from({ length: 8 }, (_, i) => ({ path: `/repo/pkg${i}/CLAUDE.md`, tokens: (i + 1) * 100 })),
  mcpTools: [
    { name: "mcp__linear__list_issues", server: "linear", tokens: 900 },
    { name: "mcp__linear__get_issue", server: "linear", tokens: 600 },
  ],
};

describe("ContextMeter", () => {
  it("draws nothing until the harness has reported a window", () => {
    const { container } = render(<ContextMeter sessionId="s" />);
    expect(container.innerHTML).toBe("");
    render(<ContextMeter sessionId="s" usage={{ used: 84_000 }} />);
    expect(screen.queryByRole("button", { name: /^Context/ })).toBeNull();
  });

  it("draws the ring and the percent, muted below 85%", () => {
    render(<ContextMeter sessionId="s" usage={{ used: 84_000, window: 200_000 }} />);
    expect(meter().textContent).toBe("42%");
    expect(meter().querySelector("[data-context-ring]")).toBeTruthy();
    expect(meter().dataset.tone).toBe("muted");
    expect(meter().className).toContain("text-muted-foreground");
  });

  it("turns amber from 85%, and never red", () => {
    for (const used of [170_000, 199_000, 400_000]) {
      render(<ContextMeter sessionId="s" usage={{ used, window: 200_000 }} />);
      expect(meter().dataset.tone).toBe("warning");
      expect(meter().className).toContain("text-warning");
      expect(meter().className).not.toMatch(/text-(destructive|danger)/);
      cleanup();
    }
    render(<ContextMeter sessionId="s" usage={{ used: 169_000, window: 200_000 }} />);
    expect(meter().dataset.tone).toBe("muted");
  });

  it("says the tokens on hover, and Compacting with a spinner while the harness compacts", async () => {
    // Warm, as after the first hover: a cold trigger swaps for the menu chunk's.
    await tooltipChunk.load();
    warmTooltips();
    await menuChunk.load();
    warmMenus();
    const hover = async (text: string) => {
      fireEvent.pointerEnter(meter(), { pointerType: "mouse" });
      fireEvent.mouseEnter(meter());
      fireEvent.mouseMove(meter());
      await waitFor(() => expect(screen.getByText(text)).toBeTruthy(), { timeout: 1500 });
    };
    // In the composer the meter sits under the bar's TooltipProvider.
    render(
      <TooltipProvider>
        <ContextMeter sessionId="s" usage={{ used: 124_000, window: 200_000 }} />
      </TooltipProvider>,
    );
    await hover("124K of 200K tokens");
    cleanup();
    render(
      <TooltipProvider>
        <ContextMeter sessionId="s" usage={{ used: 124_000, window: 200_000 }} compacting />
      </TooltipProvider>,
    );
    expect(meter().querySelector("[data-context-ring]")).toBeNull();
    expect(within(meter()).getByRole("status", { name: "Compacting" })).toBeTruthy();
    await hover("Compacting");
  });

  it("opens the breakdown on click and polls only while it is open and the turn has settled", async () => {
    cache.reading = READING;
    const { rerender } = render(<ContextMeter sessionId="s" usage={{ used: 84_000, window: 200_000 }} />);
    expect(cache.live.at(-1)).toBe(false);
    await act(async () => fireEvent.click(meter()));
    const popover = await screen.findByRole("dialog", { name: "Context" });
    expect(within(popover).getByText("84K of 200K")).toBeTruthy();
    expect(cache.live.at(-1)).toBe(true);
    rerender(<ContextMeter sessionId="s" usage={{ used: 84_000, window: 200_000 }} busy />);
    expect(cache.live.at(-1)).toBe(false);
  });

  it("offers Compact only when the thread can compact; it runs the handler and closes", async () => {
    cache.reading = READING;
    const onCompact = vi.fn();
    render(<ContextMeter sessionId="s" usage={{ used: 84_000, window: 200_000 }} onCompact={onCompact} />);
    await act(async () => fireEvent.click(meter()));
    await screen.findByRole("dialog", { name: "Context" });
    expect(screen.queryByRole("button", { name: "Compact" })).toBeNull();
    cleanup();
    render(<ContextMeter sessionId="s" usage={{ used: 84_000, window: 200_000 }} compactable onCompact={onCompact} />);
    await act(async () => fireEvent.click(meter()));
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Compact" })));
    expect(onCompact).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Context" })).toBeNull());
  });
});

describe("ContextBreakdown", () => {
  it("heads with the live total, lists the categories largest first and drops the empty ones", () => {
    const { container } = render(<ContextBreakdown reading={READING} usage={{ used: 90_000, window: 200_000 }} />);
    expect(screen.getByText("90K of 200K")).toBeTruthy();
    const rows = [...container.querySelectorAll("[data-context-categories] > div")].map((row) => row.textContent);
    expect(rows).toEqual(["Messages52K", "System tools15K", "System prompt3.1K"]);
    // The harness's own colours never paint: tokens and colour that means something only.
    for (const el of container.querySelectorAll<HTMLElement>("*")) expect(el.style.backgroundColor).toBe("");
  });

  it("cuts each list at six rows, largest first, with +N more", () => {
    const { container } = render(<ContextBreakdown reading={READING} />);
    // No category names these lists here, so each stands on its own with its total.
    const memory = container.querySelector('[data-context-list="Memory files"]')!;
    expect(memory.firstElementChild?.textContent).toBe("Memory files3.6K");
    const rows = (title: string) =>
      [...container.querySelector(`[data-context-rows="${title}"]`)!.children].map((row) => row.textContent);
    expect(rows("Memory files")).toEqual([
      "pkg7/CLAUDE.md800",
      "pkg6/CLAUDE.md700",
      "pkg5/CLAUDE.md600",
      "pkg4/CLAUDE.md500",
      "pkg3/CLAUDE.md400",
      "pkg2/CLAUDE.md300",
      "+2 more",
    ]);
    expect(rows("MCP tools")).toEqual(["linear/list_issues900", "linear/get_issue600"]);
  });

  it("puts a list under the category it details, so its total is said once", () => {
    const named: ContextReading = {
      ...READING,
      categories: [...READING.categories!, { name: "Memory files", tokens: 3_600 }, { name: "MCP tools", tokens: 1_500 }],
    };
    const { container } = render(<ContextBreakdown reading={named} />);
    expect(container.querySelector("[data-context-list]")).toBeNull();
    const memory = container.querySelector('[data-context-category="Memory files"]')!;
    expect(memory.querySelector('[data-context-rows="Memory files"]')?.children).toHaveLength(7);
    expect(container.textContent!.match(/3\.6K/g)).toHaveLength(1);
    expect(container.querySelector('[data-context-category="MCP tools"] [data-context-rows="MCP tools"]')).toBeTruthy();
  });

  it("holds skeleton rows until the first reading, and says one line mid-turn without one", () => {
    const { container } = render(<ContextBreakdown reading={null} usage={{ used: 1_000, window: 200_000 }} />);
    expect(container.querySelector("[data-context-loading]")?.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    cleanup();
    render(<ContextBreakdown reading={null} usage={{ used: 1_000, window: 200_000 }} busy />);
    expect(screen.getByText("Breakdown after this turn")).toBeTruthy();
    expect(document.querySelector("[data-context-loading]")).toBeNull();
  });

  it("says Compacting while the harness compacts, and draws Compact only with a handler", () => {
    const onCompact = vi.fn();
    const { rerender } = render(<ContextBreakdown reading={READING} compacting />);
    expect(screen.getByText("Compacting")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Compact" })).toBeNull();
    rerender(<ContextBreakdown reading={READING} onCompact={onCompact} />);
    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(onCompact).toHaveBeenCalledOnce();
  });

  it("a reading with no categories (Codex) keeps the head line and Compact", () => {
    const { container } = render(
      <ContextBreakdown reading={{ totalTokens: 9_000, maxTokens: 400_000, percentage: 2 }} onCompact={() => {}} />,
    );
    expect(container.querySelector("[data-context-categories]")).toBeNull();
    expect(screen.getByText("9K of 400K")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compact" })).toBeTruthy();
  });
});
