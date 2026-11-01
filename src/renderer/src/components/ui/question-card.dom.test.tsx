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

  it("draws an option's description as its own line and answers with the bare label", () => {
    const onSubmitAnswers = vi.fn();
    const questions: Question[] = [{ prompt: "Which?", options: [{ label: "Tabs", description: "Hard tabs, width 2" }, { label: "Spaces" }] }];
    render(<QuestionCard questions={questions} onSubmitAnswers={onSubmitAnswers} />);
    const tabs = screen.getByRole("button", { name: "Tabs" });
    expect(screen.getByText("Hard tabs, width 2").className).toContain("text-muted-foreground");
    expect(tabs.getAttribute("aria-describedby")).toBe(screen.getByText("Hard tabs, width 2").id);
    expect(screen.getByRole("button", { name: "Spaces" }).hasAttribute("aria-describedby")).toBe(false);
    fireEvent.click(tabs);
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(onSubmitAnswers).toHaveBeenCalledWith([["Tabs"]]);
  });

  it("is a group named by its title, with the caller's glyph flat beside it", () => {
    render(<QuestionCard title="Indentation" icon={<svg data-testid="glyph" />} questions={one} />);
    const group = screen.getByRole("group", { name: "Indentation" });
    const slot = screen.getByTestId("glyph").parentElement!;
    expect(group.contains(slot)).toBe(true);
    expect(slot.className).not.toContain("bg-muted");
  });

  it("shows the progress donut and reset only for more than one question, or when asked", () => {
    const two: Question[] = [...one, { prompt: "And?", options: [{ label: "Yes" }] }];
    const { rerender } = render(<QuestionCard questions={one} />);
    expect(screen.queryByRole("button", { name: "Reset the answers" })).toBeNull();
    expect(screen.queryByText(/answered/)).toBeNull();
    rerender(<QuestionCard questions={two} />);
    expect(screen.getByRole("button", { name: "Reset the answers" })).toBeTruthy();
    expect(screen.getByText("0 of 2 answered")).toBeTruthy();
    rerender(<QuestionCard questions={two} showProgress={false} />);
    expect(screen.queryByRole("button", { name: "Reset the answers" })).toBeNull();
    rerender(<QuestionCard questions={one} showProgress />);
    expect(screen.getByRole("button", { name: "Reset the answers" })).toBeTruthy();
  });
});
