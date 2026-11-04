// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QuestionCard, type Question } from "./question-card";

afterEach(cleanup);

const one: Question[] = [{ prompt: "Which?", options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Other", freeform: true }] }];

describe("QuestionCard's motion", () => {
  it("snaps its frame to the page and leaves its title glyph at its own size", () => {
    const { container } = render(<QuestionCard title="Indentation" icon={<svg data-testid="glyph" />} questions={[{ prompt: "Which?", options: [{ label: "Tabs" }, { label: "Spaces" }] }]} />);
    const frame = container.querySelector<HTMLElement>('[data-slot="question-card"] .overflow-hidden')!;
    expect(frame.className).not.toMatch(/transition/);
    expect(screen.getByTestId("glyph").parentElement!.className).not.toContain("[&_svg]");
  });

  it("moves Previous by a full transform string, with no blur", () => {
    const source = readFileSync(resolve(__dirname, "question-card.tsx"), "utf8");
    const previous = source.slice(source.indexOf("const PREVIOUS"), source.indexOf("};", source.indexOf("const PREVIOUS")));
    expect(previous).toContain('transform: "translateX(-8px)"');
    expect(previous).not.toMatch(/blur|filter|\bx:/);
    const label = source.slice(source.indexOf("function MorphLabel"), source.indexOf("\n}\n", source.indexOf("function MorphLabel")));
    expect(label).not.toMatch(/width/);
  });
});

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

  it("keeps the transcript's geometry: a 12px morph inset, 28px option rows, 20px key caps, the prompt at 14 on 22", () => {
    const { container } = render(<QuestionCard questions={one} />);
    const card = container.querySelector<HTMLElement>('[data-slot="question-card"]')!;
    const frame = card.querySelector<HTMLElement>(".overflow-hidden")!;
    expect(frame.className.split(" ")).toEqual(expect.arrayContaining(["-m-3", "p-3"]));
    const prompt = screen.getByText("Which?");
    expect(prompt.className.split(" ")).toEqual(expect.arrayContaining(["text-sm", "leading-[22px]"]));
    const list = card.querySelector<HTMLElement>("ul")!;
    expect(list.className.split(" ")).toEqual(expect.arrayContaining(["-mx-2", "mt-2"]));
    // An option highlights at once, 4px inside the card's 8px corner on a concentric 4px radius.
    const option = list.querySelector<HTMLElement>(".min-h-7")!;
    expect(option.className.split(" ")).toEqual(expect.arrayContaining(["rounded-sm", "duration-(--dur-instant)"]));
    expect(option.className).not.toMatch(/transition-\[|rounded-md/);
    const rows = [...list.querySelectorAll<HTMLElement>("button[aria-pressed]")];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.className.split(" ")).toEqual(expect.arrayContaining(["min-h-7", "px-2", "gap-2", "rounded-sm"]));
      expect(row.className).not.toMatch(/\b(gap-3|px-2\.5|rounded-lg)\b/);
      const cap = row.firstElementChild as HTMLElement;
      expect(cap.textContent).toMatch(/^[ABC]$/);
      expect(cap.className.split(" ")).toEqual(expect.arrayContaining(["size-5", "rounded-sm"]));
    }
  });

  it("draws no border, fill or padding of its own inside a card", () => {
    const { container } = render(<QuestionCard questions={one} />);
    const card = container.querySelector<HTMLElement>('[data-slot="question-card"]')!;
    for (const c of ["in-[.bg-card]:border-0", "in-[.bg-card]:bg-transparent", "in-[.bg-card]:p-0"]) expect(card.className).toContain(c);
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
