// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QuestionCard, type Question } from "./question-card";

afterEach(cleanup);

const one: Question[] = [{ prompt: "Which?", options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Other", freeform: true }] }];

/** One key typed into a field as a browser delivers it: keydown, the text,
 *  keyup. jsdom has no activation behaviour, so this plays Chromium's: a
 *  Space or Enter inside a button clicks that button. */
const typeKey = (field: HTMLInputElement, key: string) => {
  fireEvent.keyDown(field, { key });
  if (key.length === 1) fireEvent.change(field, { target: { value: field.value + key } });
  fireEvent.keyUp(field, { key });
  const host = field.parentElement?.closest("button");
  if (host && (key === " " || key === "Enter")) fireEvent.click(host);
};

describe("QuestionCard's motion", () => {
  const two: Question[] = [
    { prompt: "Which?", options: [{ label: "Alpha" }, { label: "Beta" }] },
    { prompt: "And?", options: [{ label: "Yes" }, { label: "No" }] },
  ];

  it("glides its frame's height on the tokens and leaves its title glyph at its own size", () => {
    const { container } = render(<QuestionCard title="Indentation" icon={<svg data-testid="glyph" />} questions={two} />);
    const frame = container.querySelector<HTMLElement>('[data-slot="question-pages"]')!;
    expect(frame.className.split(" ")).toEqual(
      expect.arrayContaining(["transition-[height]", "duration-(--dur-base)", "ease-(--ease-out)", "motion-reduce:transition-none", "overflow-hidden"]),
    );
    expect(screen.getByTestId("glyph").parentElement!.className).not.toContain("[&_svg]");
  });

  it("Next cross-fades the questions in place: the card and every page keep their elements, opacity alone moves", () => {
    const { container } = render(<QuestionCard questions={two} />);
    const card = container.querySelector('[data-slot="question-card"]')!;
    const pages = [...container.querySelectorAll<HTMLElement>("[data-page]")];
    expect(pages.map((page) => page.dataset.page)).toEqual(["current", "away"]);
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(container.querySelector('[data-slot="question-card"]')).toBe(card);
    const after = [...container.querySelectorAll<HTMLElement>("[data-page]")];
    expect(after).toEqual(pages);
    expect(after.map((page) => page.dataset.page)).toEqual(["away", "current"]);
    expect(after[0].hasAttribute("inert")).toBe(true);
    for (const page of after) {
      expect(page.className).toContain("transition-opacity");
      expect(page.className).toContain("motion-reduce:duration-(--dur-fast)");
      expect(page.className).not.toMatch(/translate|blur|scale/);
    }
    // The arriving question over --dur-base; the leaving one out faster, on the exit curve.
    expect(after[1].className.split(" ")).toEqual(expect.arrayContaining(["opacity-100", "duration-(--dur-base)", "ease-(--ease-out)"]));
    expect(after[0].className.split(" ")).toEqual(expect.arrayContaining(["opacity-0", "duration-(--dur-fast)", "ease-(--ease-exit)", "absolute"]));
  });

  it("moves Back by a full transform string, with no blur, and swaps Next's words on opacity alone", () => {
    const source = readFileSync(resolve(__dirname, "question-card.tsx"), "utf8");
    const back = source.slice(source.indexOf("const BACK"), source.indexOf("};", source.indexOf("const BACK")));
    expect(back).toContain('transform: "translateX(-8px)"');
    expect(back).not.toMatch(/blur|filter|\bx:/);
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

  it("typing in the free-form field, Space and Enter included, never unpicks its row", () => {
    const onSubmitAnswers = vi.fn();
    const { container } = render(<QuestionCard questions={one} onSubmitAnswers={onSubmitAnswers} />);
    const field = screen.getByRole("textbox", { name: "Other" });
    // The field is no child of a button: that is what turned its Space into a click.
    expect(field.closest("button")).toBeNull();
    expect(container.querySelector("button input")).toBeNull();
    const other = screen.getByRole("button", { name: "Other" });
    fireEvent.click(other);
    expect(other.getAttribute("aria-pressed")).toBe("true");
    field.focus();
    for (const key of ["a", " ", "b", "Enter"]) typeKey(field as HTMLInputElement, key);
    expect(other.getAttribute("aria-pressed")).toBe("true");
    expect((field as HTMLInputElement).value).toBe("a b");
    // A letter typed in the field picks nothing; ⌘⏎ still submits the typed text.
    expect(screen.getByRole("button", { name: "Alpha" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    expect(onSubmitAnswers).toHaveBeenCalledWith([["a b"]]);
  });

  it("the free-form row: a click picks it and focuses the field, its letter picks it, the field is a tab stop only once picked", () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<QuestionCard questions={one} />);
      const field = screen.getByRole("textbox", { name: "Other" }) as HTMLInputElement;
      const other = screen.getByRole("button", { name: "Other" });
      expect(field.readOnly).toBe(true);
      expect(field.tabIndex).toBe(-1);
      // The toggle covers the row; the field sits under it until the row is picked.
      expect(other.className.split(" ")).toEqual(expect.arrayContaining(["absolute", "inset-0", "rounded-lg"]));
      expect(field.className.split(" ")).not.toContain("relative");
      fireEvent.click(other);
      act(() => vi.runAllTimers());
      expect(document.activeElement).toBe(field);
      expect(field.readOnly).toBe(false);
      expect(field.tabIndex).toBe(0);
      expect(field.className.split(" ")).toContain("relative");
      const row = container.querySelector<HTMLElement>('[data-slot="question-option"]:has(input)')!;
      expect(row.className.split(" ")).toContain("bg-foreground/10");
      fireEvent.click(other);
      expect(other.getAttribute("aria-pressed")).toBe("false");
      const alpha = screen.getByRole("button", { name: "Alpha" });
      alpha.focus();
      fireEvent.keyDown(alpha, { key: "c" });
      expect(other.getAttribute("aria-pressed")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
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

  it("keeps its geometry: 16px inset, a 12px page inset, 36px flat option rows, 20px key caps, the prompt at 14 on 22", () => {
    const { container } = render(<QuestionCard questions={one} />);
    const card = container.querySelector<HTMLElement>('[data-slot="question-card"]')!;
    expect(card.className.split(" ")).toEqual(expect.arrayContaining(["rounded-xl", "p-4", "border", "bg-card"]));
    const frame = card.querySelector<HTMLElement>('[data-slot="question-pages"]')!;
    expect(frame.className.split(" ")).toEqual(expect.arrayContaining(["-m-3", "p-3"]));
    const prompt = screen.getByText("Which?");
    expect(prompt.className.split(" ")).toEqual(expect.arrayContaining(["text-sm", "leading-[22px]"]));
    const list = card.querySelector<HTMLElement>("ul")!;
    expect(list.className.split(" ")).toEqual(expect.arrayContaining(["-mx-2", "mt-2", "gap-1"]));
    const rows = [...list.querySelectorAll<HTMLElement>('[data-slot="question-option"]')];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      // A menu row's 8px radius, 8px above and below the 20px line; no border, no transition: a fill changes at once.
      expect(row.className.split(" ")).toEqual(expect.arrayContaining(["min-h-9", "py-2", "px-2", "gap-3", "rounded-lg", "active:bg-foreground/12"]));
      expect(row.className).not.toMatch(/\bborder\b|transition|duration/);
      const cap = row.querySelector<HTMLElement>('[data-slot="question-key"]')!;
      expect(cap.textContent).toMatch(/^[ABC]$/);
      expect(cap.className.split(" ")).toEqual(expect.arrayContaining(["size-5", "rounded-sm", "leading-none"]));
    }
  });

  it("says a selected option with a fill and the cap, never an outline", () => {
    render(<QuestionCard questions={one} />);
    const alpha = screen.getByRole("button", { name: "Alpha" });
    const beta = screen.getByRole("button", { name: "Beta" });
    fireEvent.click(alpha);
    expect(alpha.className.split(" ")).toContain("bg-foreground/10");
    expect(alpha.className).not.toMatch(/border|ring|outline/);
    expect((alpha.firstElementChild as HTMLElement).className.split(" ")).toEqual(expect.arrayContaining(["bg-primary", "text-primary-foreground"]));
    expect(beta.className.split(" ")).toContain("hover:bg-foreground/5");
    expect(beta.className.split(" ")).not.toContain("bg-foreground/10");
    expect((beta.firstElementChild as HTMLElement).className.split(" ")).toEqual(expect.arrayContaining(["bg-foreground/7", "text-muted-foreground"]));
  });

  it("ends with raised buttons, right-aligned 8px apart and 16px under the options: Back and Skip secondary, Next default", () => {
    const questions: Question[] = [...one, { prompt: "And?", options: [{ label: "Yes" }] }];
    const { container } = render(<QuestionCard questions={questions} onSkip={() => {}} />);
    const actions = container.querySelector<HTMLElement>('[data-slot="question-actions"]')!;
    expect(actions.className.split(" ")).toEqual(expect.arrayContaining(["mt-4", "justify-end", "gap-2"]));
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    const skip = screen.getByRole("button", { name: "Skip" });
    const next = screen.getByRole("button", { name: /Next/ });
    expect(skip.dataset.variant).toBe("secondary");
    expect(next.dataset.variant).toBe("default");
    for (const button of [skip, next]) expect(button.className).toContain("t-raise");
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    fireEvent.click(next);
    const back = screen.getByRole("button", { name: "Back" });
    expect(back.dataset.variant).toBe("secondary");
    expect(back.className).toContain("t-raise");
    // Back arrives first in the group, so Skip and Next hold their places.
    const order = [...actions.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(order[0]).toBe("Back");
    expect(order[1]).toBe("Skip");
    expect(order[2]).toContain("Continue");
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

  it("says where the person is (\"2 of 3\") only for more than one question, or when asked", () => {
    const two: Question[] = [...one, { prompt: "And?", options: [{ label: "Yes" }] }];
    const { rerender, container } = render(<QuestionCard questions={one} />);
    expect(container.querySelector('[data-slot="question-progress"]')).toBeNull();
    rerender(<QuestionCard questions={two} />);
    const progress = container.querySelector<HTMLElement>('[data-slot="question-progress"]')!;
    expect(progress.textContent).toBe("1 of 2");
    expect(progress.className.split(" ")).toEqual(expect.arrayContaining(["text-xs", "text-muted-foreground", "tabular-nums", "ms-auto"]));
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(progress.textContent).toBe("2 of 2");
    expect(screen.queryByRole("button", { name: "Reset the answers" })).toBeNull();
    rerender(<QuestionCard questions={two} showProgress={false} />);
    expect(container.querySelector('[data-slot="question-progress"]')).toBeNull();
    cleanup();
    const asked = render(<QuestionCard questions={one} showProgress />);
    expect(asked.container.querySelector('[data-slot="question-progress"]')!.textContent).toBe("1 of 1");
  });
});
