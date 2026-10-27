// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionCard, type Question } from "./question-card";

afterEach(cleanup);

const one: Question[] = [{ prompt: "Which?", options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Other", freeform: true }] }];

describe("QuestionCard", () => {
  it("sets the sans face on its root, whatever the transcript row around it uses", () => {
    const { container } = render(
      <div className="font-mono">
        <QuestionCard questions={one} onSubmitAnswers={() => {}} />
      </div>,
    );
    const card = container.querySelector('[data-slot="question-card"]')!;
    expect(card.classList.contains("font-sans")).toBe(true);
    expect(card.querySelector(".font-mono")).toBeNull();
  });

  it("keys act only while focus is inside the card", () => {
    const onSubmitAnswers = vi.fn();
    render(
      <>
        <textarea aria-label="composer" />
        <QuestionCard questions={one} onSubmitAnswers={onSubmitAnswers} />
      </>,
    );
    const composer = screen.getByLabelText("composer");
    composer.focus();
    fireEvent.keyDown(composer, { key: "a" });
    fireEvent.keyDown(composer, { key: "Enter", metaKey: true });
    expect(screen.getByRole("button", { name: "Alpha" }).getAttribute("aria-pressed")).toBe("false");
    expect(onSubmitAnswers).not.toHaveBeenCalled();

    const alpha = screen.getByRole("button", { name: "Alpha" });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: "b" });
    expect(screen.getByRole("button", { name: "Beta" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(alpha, { key: "Enter", metaKey: true });
    expect(onSubmitAnswers).toHaveBeenCalledWith([["Beta"]]);
  });

  it("a single-select question keeps one pick; a multi-select one takes several and submits them together", () => {
    const onSubmitAnswers = vi.fn();
    const questions: Question[] = [
      { prompt: "Which?", options: [{ label: "Alpha" }, { label: "Beta" }] },
      { prompt: "Any of these?", multiSelect: true, options: [{ label: "One" }, { label: "Two" }, { label: "Three" }] },
    ];
    render(<QuestionCard questions={questions} onSubmitAnswers={onSubmitAnswers} />);
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    expect(screen.getByRole("button", { name: "Alpha" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Beta" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    const lists = screen.getAllByRole("list", { hidden: true });
    expect(lists[0].getAttribute("aria-multiselectable")).toBe(null);
    expect(lists[1].getAttribute("aria-multiselectable")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "One" }));
    fireEvent.click(screen.getByRole("button", { name: "Three" }));
    expect(screen.getByRole("button", { name: "One" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Three" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Three" }));
    fireEvent.click(screen.getByRole("button", { name: "Two" }));
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(onSubmitAnswers).toHaveBeenCalledWith([["Beta"], ["One", "Two"]]);
  });
});
