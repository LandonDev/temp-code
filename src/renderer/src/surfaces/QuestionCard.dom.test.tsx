// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tcserver/commands", () => ({ answer: vi.fn() }));

import type { QuestionMeta, QuestionSpec } from "../lib/session";
import { QuestionCard, cardQuestions } from "./QuestionCard";

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

  it("is the failure card's frame (full width, rounded-lg, p-3) and leaves the type to the card", () => {
    const view = render(<QuestionCard question={meta([spec("Which?", ["A"], { header: "File" })])} onAnswer={() => {}} />);
    const card = view.container.querySelector<HTMLElement>('[data-slot="question-card"]')!;
    for (const cls of ["max-w-none", "rounded-lg", "p-3"]) expect(card.className.split(" ")).toContain(cls);
    for (const cls of ["max-w-lg", "rounded-xl", "p-4"]) expect(card.className.split(" ")).not.toContain(cls);
    expect(card.className).not.toContain("[&_h3]");
  });

  it("carries the amber Needs you glyph by its title, without the word", () => {
    const view = render(<QuestionCard question={meta([spec("Which?", ["A"], { header: "File" })])} onAnswer={() => {}} />);
    const card = screen.getByRole("group", { name: "File" });
    const mark = card.querySelector<HTMLElement>('[data-slot="status-mark"]')!;
    expect(mark.dataset.state).toBe("waiting");
    expect(mark.querySelector('[data-slot="status-word"]')).toBeNull();
    expect(view.container.textContent).not.toContain("Needs you");
  });

  it("shows no progress mark for one question, and the donut for two", () => {
    const one = render(<QuestionCard question={meta([spec("Which?", ["A"])])} onAnswer={() => {}} />);
    expect(one.container.querySelector('button[aria-label="Reset the answers"]')).toBeNull();
    expect(one.container.textContent).not.toContain("answered");
    one.unmount();
    const two = render(<QuestionCard question={meta([spec("A?", ["A"]), spec("B?", ["B"])])} onAnswer={() => {}} />);
    expect(two.container.querySelector('button[aria-label="Reset the answers"]')).not.toBeNull();
    expect(two.container.textContent).toContain("0 of 2 answered");
  });

  it("cardQuestions passes descriptions through, keeps a header the title already says out, and adds Other", () => {
    const question = meta([
      { question: "Which?", header: "File", options: [{ label: "a.ts", description: "the old one" }, { label: "b.ts" }] },
      { question: "How?", header: "Speed", options: [{ label: "Fast" }], allowFreeform: false },
    ]);
    expect(cardQuestions(question, "File")).toEqual([
      {
        prompt: "Which?",
        description: undefined,
        multiSelect: undefined,
        options: [{ label: "a.ts", description: "the old one" }, { label: "b.ts", description: undefined }, { label: "Other", freeform: true }],
      },
      { prompt: "How?", description: "Speed", multiSelect: undefined, options: [{ label: "Fast", description: undefined }] },
    ]);
  });

  it("shows an option's description and answers with its bare label", () => {
    const onAnswer = vi.fn();
    const view = render(
      <QuestionCard
        question={meta([{ question: "Count free items?", options: [{ label: "Count them", description: "Free items add to the total" }, { label: "Skip them" }] }])}
        onAnswer={onAnswer}
      />,
    );
    const picked = screen.getByRole("button", { name: "Count them", description: "Free items add to the total" });
    fireEvent.click(picked);
    fireEvent.click(advance());
    expect(onAnswer).toHaveBeenCalledWith("q1", [["Count them"]]);
  });
});
