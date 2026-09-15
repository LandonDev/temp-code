// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/highlight", () => ({ highlightCode: () => Promise.resolve(null) }));
vi.mock("../lib/sounds", () => ({ playCue: () => {} }));

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= NoopObserver;
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver ??= NoopObserver;

import { AgentTranscript, shouldRestoreScroll, windowTurns } from "./AgentTranscript";
import type { Block } from "../lib/session";
import type { TranscriptScrollMemory } from "../lib/transcriptScrollMemory";

/** Two user turns of `perTurn` rows: prompt then completed tool calls. */
function agentLog(perTurn: number): Block[] {
  const blocks: Block[] = [];
  for (let t = 0; t < 2; t++) {
    blocks.push({ id: `u${t}`, role: "user", text: `prompt ${t}` });
    for (let i = 1; i < perTurn; i++) {
      blocks.push({
        id: `t${t}-${i}`,
        role: "tool",
        text: `Read f${i}`,
        tool: { callId: `c${t}-${i}`, name: "Read", kind: "read", status: "completed", title: `Read f${i}`, input: { file_path: `/repo/f${i}` } },
      });
    }
  }
  return blocks;
}

afterEach(cleanup);

const rows = (container: HTMLElement) => container.querySelectorAll("[data-block]").length;

describe("shouldRestoreScroll", () => {
  const memory: TranscriptScrollMemory = { fromBottom: 400, rowCount: 100 };

  it("puts the reader back where they scrolled up from while the run is still going", () => {
    expect(shouldRestoreScroll(memory, true)).toBe(true);
  });

  it("sends a settled thread to the bottom, discarding a scroll-up from before it finished", () => {
    expect(shouldRestoreScroll(memory, false)).toBe(false);
    expect(shouldRestoreScroll(memory, undefined)).toBe(false);
  });

  it("has nothing to restore when the thread never left the bottom", () => {
    expect(shouldRestoreScroll(undefined, true)).toBe(false);
    expect(shouldRestoreScroll(undefined, false)).toBe(false);
  });
});

describe("windowTurns", () => {
  it("cuts the last rows out of the turns, part-way through a big turn", () => {
    const turns = [Array(5).fill(0), Array(1000).fill(0), Array(20).fill(0)] as unknown as Block[][];
    expect(windowTurns(turns, 100)).toEqual({ first: 1, skip: 920, shown: 100 });
    expect(windowTurns(turns, 2000)).toEqual({ first: 0, skip: 0, shown: 1025 });
  });
  it("snaps to the turn's start when the cut would drop under half a page", () => {
    const turns = [Array(40).fill(0), Array(90).fill(0)] as unknown as Block[][];
    expect(windowTurns(turns, 100)).toEqual({ first: 0, skip: 0, shown: 130 });
  });
});

describe("AgentTranscript row window", () => {
  it("a 2-turn, 2,000-row log paints the last 100 rows and grows by a page on demand", async () => {
    const blocks = agentLog(1000);
    const { container, getByText } = render(
      <AgentTranscript sessionId="s1" blocks={blocks} busy={false} visible />,
    );
    expect(rows(container)).toBe(100);
    const shown = [...container.querySelectorAll("[data-block]")].map((el) => el.getAttribute("data-block"));
    expect(shown[0]).toBe("t1-900");
    expect(shown.at(-1)).toBe("t1-999");
    await act(async () => {
      fireEvent.click(getByText("Load earlier messages"));
    });
    expect(rows(container)).toBe(250);
  });

  it("a short log paints whole, with no button", () => {
    const { container, queryByText } = render(
      <AgentTranscript sessionId="s2" blocks={agentLog(20)} busy={false} visible />,
    );
    expect(rows(container)).toBe(40);
    expect(queryByText("Load earlier messages")).toBeNull();
  });
});
