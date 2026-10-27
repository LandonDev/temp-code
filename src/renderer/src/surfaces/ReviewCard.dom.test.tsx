// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewFinding } from "@server/shared/review";

const mergeAnyway = vi.fn<(sessionId: string, runId: string) => Promise<void>>(() => new Promise(() => {}));
vi.mock("../lib/tcserver/commands", () => ({
  mergeAnyway: (sessionId: string, runId: string) => mergeAnyway(sessionId, runId),
}));
vi.mock("../lib/threads/agents", () => ({ modelLabel: () => "GPT-6.1 Sol" }));

import type { Block } from "../lib/session";
import { TranscriptSessionContext } from "./transcriptSession";
import { ReviewCard } from "./ReviewCard";

const finding = (file: string, line: number, summary: string, scenario = ""): ReviewFinding => ({
  file,
  line,
  summary,
  failure_scenario: scenario,
});
const review = (over: Partial<NonNullable<Block["review"]>>): Block => ({
  id: "r",
  role: "system",
  text: "",
  review: {
    runId: "run1",
    reviewerId: "rev1",
    provider: "codex",
    model: "gpt-6.1-sol",
    outcome: "pass",
    branch: "feature",
    target: "master",
    blocking: [],
    minor: [],
    merged: true,
    pushed: true,
    ...over,
  } as NonNullable<Block["review"]>,
});
const mount = (block: Block, onOpenFile = vi.fn()) =>
  render(
    <TranscriptSessionContext.Provider value="s1">
      <ReviewCard block={block} cwd="/repo" onOpenFile={onOpenFile} />
    </TranscriptSessionContext.Provider>,
  );

afterEach(() => {
  cleanup();
  mergeAnyway.mockClear();
});

describe("ReviewCard", () => {
  it("a pass is one line with its minor count, the minor findings closed", () => {
    const { container } = mount(review({ minor: [finding("a.ts", 3, "Nit")] }));
    expect(container.querySelectorAll('[data-slot="notice-line"]').length).toBe(1);
    expect(container.textContent).toContain("Reviewed by GPT-6.1 Sol");
    expect(container.textContent).toContain("no blocking findings");
    expect(container.textContent).toContain("1 minor");
    expect(container.textContent).not.toContain("Nit");
    fireEvent.click(screen.getByRole("button", { name: "Show minor findings" }));
    expect(container.textContent).toContain("Nit");
  });

  it("a live hold is a card listing file:line, summary and scenario", () => {
    const onOpenFile = vi.fn();
    const { container } = mount(
      review({ outcome: "held", merged: false, blocking: [finding("src/x.ts", 12, "Drops the error", "A 500 reads as success")] }),
      onOpenFile,
    );
    const card = container.querySelector('[data-slot="review-hold"]')!;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("1 blocking finding");
    expect(card.textContent).toContain("merge held");
    expect(card.textContent).toContain("Drops the error");
    expect(card.textContent).toContain("A 500 reads as success");
    expect(card.textContent).not.toContain("Address the findings");
    fireEvent.click(screen.getByRole("button", { name: "src/x.ts:12" }));
    expect(onOpenFile).toHaveBeenCalledWith("/repo/src/x.ts", { line: 12 });
  });

  it("Merge anyway calls the override and reads Merging…", async () => {
    mount(review({ outcome: "held", merged: false, blocking: [finding("x.ts", 1, "Bad")] }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Merge anyway" }));
    });
    expect(mergeAnyway).toHaveBeenCalledWith("s1", "run1");
    expect(screen.getByRole("button", { name: "Merging…" })).toBeTruthy();
  });

  it("a hold's minor findings stay collapsed", () => {
    const { container } = mount(
      review({ outcome: "held", merged: false, blocking: [finding("x.ts", 1, "Bad")], minor: [finding("y.ts", 2, "Small thing")] }),
    );
    expect(container.textContent).toContain("1 minor finding");
    expect(container.textContent).not.toContain("Small thing");
  });
});
