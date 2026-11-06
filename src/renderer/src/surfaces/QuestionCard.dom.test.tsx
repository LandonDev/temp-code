// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tcserver/commands", () => ({ answer: vi.fn() }));
const toastError = vi.fn();
vi.mock("../components/ui/toaster", () => ({ loadToast: () => Promise.resolve({ error: toastError }) }));

import type { QuestionMeta, QuestionSpec } from "../lib/session";
import { CARD_SHAPE, QUESTION_ENTER, QUESTION_SHAPE, QuestionCard, cardQuestions } from "./QuestionCard";

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
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
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
    expect(lines[0].textContent).toBe("AnsweredFile: A");
    expect(lines[1].textContent).toBe("AnsweredHow? Fast");
    answered.unmount();
    // A label stays whole: "Approach: Fast, Small", never "Approach, Fast, Small".
    const several = render(<QuestionCard question={meta([spec("Which?", ["Fast", "Small"], { header: "Approach" })], [["Fast", "Small"]])} />);
    expect(several.container.querySelector('[data-slot="notice-line"]')!.textContent).toBe("AnsweredApproach: Fast, Small");
    several.unmount();
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

  it("is a card that stands alone (full width, rounded-xl, p-4) from the exported QUESTION_SHAPE, and leaves the type to the card", () => {
    expect(QUESTION_SHAPE).toBe("max-w-none rounded-xl p-4");
    // The held review keeps the transcript's other frame.
    expect(CARD_SHAPE).toBe("max-w-none rounded-lg p-3");
    const view = render(<QuestionCard question={{ ...meta([spec("Which?", ["A"], { header: "File" })]), requestId: "shape" }} onAnswer={() => {}} />);
    const card = view.container.querySelector<HTMLElement>('[data-slot="question-card"]')!;
    for (const cls of QUESTION_SHAPE.split(" ")) expect(card.className.split(" ")).toContain(cls);
    for (const cls of ["max-w-lg", "rounded-lg", "p-3"]) expect(card.className.split(" ")).not.toContain(cls);
    expect(card.className).not.toContain("[&_h3]");
  });

  it("enters once, as a transcript row does: a fade and a 4px rise on the tokens, opacity alone under reduced motion", () => {
    for (const cls of ["transition-[opacity,translate]", "duration-(--dur-base)", "ease-(--ease-out)", "starting:translate-y-1", "starting:opacity-0", "motion-reduce:duration-(--dur-fast)", "motion-reduce:starting:translate-y-0"]) {
      expect(QUESTION_ENTER.split(" ")).toContain(cls);
    }
    const question = { ...meta([spec("Which?", ["A"])]), requestId: "enter" };
    const first = render(<QuestionCard question={question} onAnswer={() => {}} />);
    const card = () => document.querySelector<HTMLElement>('[data-slot="question-card"]')!;
    expect(card().className).toContain("starting:opacity-0");
    first.unmount();
    // The transcript's window mounting the row again replays nothing.
    render(<QuestionCard question={question} onAnswer={() => {}} />);
    expect(card().className).not.toContain("starting:opacity-0");
    cleanup();
    // A set answered before this mount never enters.
    render(<QuestionCard question={{ ...question, requestId: "old", answers: [["A"]] }} />);
    expect(document.querySelector('[data-slot="question-card"]')).toBeNull();
  });

  it("an answer folds the card closed on .collapsible-auto and opens the answered lines in its place, at the click", async () => {
    const onAnswer = vi.fn(() => new Promise<void>(() => {}));
    const question = { ...meta([spec("Which?", ["A", "B"], { header: "File" })]), requestId: "fold" };
    const view = render(<QuestionCard question={question} onAnswer={onAnswer} />);
    const card = view.container.querySelector<HTMLElement>('[data-slot="question-card"]')!;
    const fold = card.closest<HTMLElement>('[data-slot="collapsible-content"]')!;
    expect(fold.className).toContain("collapsible-auto");
    expect(view.container.querySelector('[data-slot="notice-line"]')).toBeNull();
    fireEvent.click(option(view.container, "B"));
    await act(async () => fireEvent.click(advance()));
    expect(onAnswer).toHaveBeenCalledWith("fold", [["B"]]);
    // Before the host echoes it: the card's fold is closing, the lines' fold open on the same curve.
    expect(fold.isConnected).toBe(true);
    expect(fold.closest('[data-slot="collapsible"]')!.hasAttribute("data-closed")).toBe(true);
    const line = view.container.querySelector<HTMLElement>('[data-slot="notice-line"]')!;
    expect(line.textContent).toBe("AnsweredFile: B");
    expect(line.closest('[data-slot="collapsible-content"]')!.className).toContain("collapsible-auto");
    // The closed card leaves the accessibility tree, so nothing answers twice.
    expect(screen.queryByRole("button", { name: /^(Next|Continue)/ })).toBeNull();
    expect(onAnswer).toHaveBeenCalledTimes(1);
    // The host's echo keeps the lines and lets the card go.
    view.rerender(<QuestionCard question={{ ...question, answers: [["B"]] }} onAnswer={onAnswer} />);
    expect(view.container.querySelector('[data-slot="notice-line"]')!.textContent).toBe("AnsweredFile: B");
  });

  it("an answer the host never took opens the card again with its picks, and says so", async () => {
    toastError.mockClear();
    const onAnswer = vi.fn(() => Promise.reject(new Error("link down")));
    const question = { ...meta([spec("Which?", ["A", "B"])]), requestId: "refused" };
    const view = render(<QuestionCard question={question} onAnswer={onAnswer} />);
    fireEvent.click(option(view.container, "B"));
    await act(async () => fireEvent.click(advance()));
    await act(async () => {});
    expect(toastError).toHaveBeenCalledWith("Couldn't send the answer");
    expect(view.container.querySelector('[data-slot="collapsible"]')!.hasAttribute("data-open")).toBe(true);
    expect(option(view.container, "B").getAttribute("aria-pressed")).toBe("true");
  });

  it("carries the amber Needs you glyph by its title, without the word", () => {
    const view = render(<QuestionCard question={meta([spec("Which?", ["A"], { header: "File" })])} onAnswer={() => {}} />);
    const card = screen.getByRole("group", { name: "File" });
    const mark = card.querySelector<HTMLElement>('[data-slot="status-mark"]')!;
    expect(mark.dataset.state).toBe("waiting");
    expect(mark.querySelector('[data-slot="status-word"]')).toBeNull();
    expect(view.container.textContent).not.toContain("Needs you");
  });

  it("says no position for one question, and where the person is for two", () => {
    const one = render(<QuestionCard question={meta([spec("Which?", ["A"])])} onAnswer={() => {}} />);
    expect(one.container.querySelector('[data-slot="question-progress"]')).toBeNull();
    one.unmount();
    const two = render(<QuestionCard question={meta([spec("A?", ["A"]), spec("B?", ["B"])])} onAnswer={() => {}} />);
    expect(two.container.querySelector('[data-slot="question-progress"]')!.textContent).toBe("1 of 2");
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
