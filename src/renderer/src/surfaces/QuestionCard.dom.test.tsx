// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tcserver/commands", () => ({ answer: vi.fn() }));

import type { QuestionMeta, QuestionSpec } from "../lib/session";
import { QuestionCard } from "./QuestionCard";

const meta = (questions: QuestionSpec[], answers?: string[][] | null): QuestionMeta => ({
  sessionId: "s1",
  requestId: "q1",
  questions,
  answers,
});
const spec = (question: string, labels: string[], over: Partial<QuestionSpec> = {}): QuestionSpec => ({
  question,
  options: labels.map((label) => ({ label })),
  ...over,
});
const option = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find((b) => b.textContent?.includes(label))!;
const advance = () => screen.getByRole("button", { name: /^(Next|Continue)/ });

afterEach(cleanup);

describe("QuestionCard", () => {
  it("walks a two-question set to Continue and sends both answers", async () => {
    const onAnswer = vi.fn();
    const view = render(
      <QuestionCard
        question={meta([spec("Which file?", ["a.ts", "b.ts"], { header: "File" }), spec("How?", ["Fast", "Safe"])])}
        onAnswer={onAnswer}
      />,
    );
    fireEvent.click(option(view.container, "b.ts"));
    expect(advance().textContent).toMatch(/^Next/);
    await act(async () => fireEvent.click(advance()));
    fireEvent.click(option(view.container, "Safe"));
    expect(advance().textContent).toContain("Continue");
    fireEvent.click(advance());
    expect(onAnswer).toHaveBeenCalledWith("q1", [["b.ts"], ["Safe"]]);
  });

  it("a multi-select question keeps two picks", () => {
    const onAnswer = vi.fn();
    const view = render(<QuestionCard question={meta([spec("Which?", ["A", "B", "C"], { multiSelect: true })])} onAnswer={onAnswer} />);
    fireEvent.click(option(view.container, "A"));
    fireEvent.click(option(view.container, "C"));
    expect(option(view.container, "A").getAttribute("aria-pressed")).toBe("true");
    expect(option(view.container, "C").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(advance());
    expect(onAnswer).toHaveBeenCalledWith("q1", [["A", "C"]]);
  });

  it("Other takes typed text", () => {
    const onAnswer = vi.fn();
    const view = render(<QuestionCard question={meta([spec("Which?", ["A"])])} onAnswer={onAnswer} />);
    const field = view.container.querySelector<HTMLInputElement>('input[placeholder="Other"]')!;
    fireEvent.click(field.closest("button")!);
    fireEvent.change(field, { target: { value: "Neither" } });
    fireEvent.click(advance());
    expect(onAnswer).toHaveBeenCalledWith("q1", [["Neither"]]);
  });

  it("Skip sends null", () => {
    const onAnswer = vi.fn();
    render(<QuestionCard question={meta([spec("Which?", ["A"])])} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onAnswer).toHaveBeenCalledWith("q1", null);
  });

  it("an answered set is one line per question; a dismissed one is one line", () => {
    const answered = render(
      <QuestionCard question={meta([spec("Which?", ["A"], { header: "File" }), spec("How?", ["Fast"])], [["A"], ["Fast"]])} />,
    );
    const lines = answered.container.querySelectorAll('[data-slot="notice-line"]');
    expect(lines.length).toBe(2);
    expect(lines[0].textContent).toBe("AnsweredFileA");
    expect(lines[1].textContent).toBe("AnsweredHow?Fast");
    answered.unmount();
    const dismissed = render(<QuestionCard question={meta([spec("Which?", ["A"])], null)} />);
    expect(dismissed.container.textContent).toBe("Dismissed");
  });

  it("keys reach only the card they are typed in", () => {
    const view = render(
      <div>
        <textarea aria-label="composer" />
        <div data-testid="one">
          <QuestionCard question={meta([spec("First?", ["A", "B"], { allowFreeform: false })])} onAnswer={() => {}} />
        </div>
        <div data-testid="two">
          <QuestionCard question={{ ...meta([spec("Second?", ["A", "B"], { allowFreeform: false })]), requestId: "q2" }} onAnswer={() => {}} />
        </div>
      </div>,
    );
    fireEvent.keyDown(screen.getByLabelText("composer"), { key: "a" });
    expect(view.container.querySelector('[aria-pressed="true"]')).toBeNull();
    const one = screen.getByTestId("one");
    fireEvent.keyDown(within(one).getAllByRole("button", { pressed: false })[0], { key: "b" });
    expect(option(one, "B").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("two").querySelector('[aria-pressed="true"]')).toBeNull();
  });
});
