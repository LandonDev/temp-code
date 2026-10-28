import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { FindBar, type FindBarProps } from "./FindBar";

const props = (over: Partial<FindBarProps> = {}): FindBarProps => ({
  search: "foo",
  replace: "",
  caseSensitive: false,
  wholeWord: false,
  regexp: false,
  replaceVisible: false,
  count: { text: "2 of 7", state: "ok" },
  searchRef: createRef(),
  replaceRef: createRef(),
  onSearch: vi.fn(),
  onReplace: vi.fn(),
  onToggle: vi.fn(),
  onToggleReplace: vi.fn(),
  onPrev: vi.fn(),
  onNext: vi.fn(),
  onClose: vi.fn(),
  onReplaceNext: vi.fn(),
  onReplaceAll: vi.fn(),
  onKeyDown: vi.fn(),
  onCompositionStart: vi.fn(),
  onCompositionEnd: vi.fn(),
  ...over,
});

const byLabel = (root: HTMLElement, label: string) => root.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;

describe("FindBar", () => {
  afterEach(cleanup);

  it("shows the count in its tone: muted when it found something, destructive when it did not", () => {
    const { container, rerender } = render(<FindBar {...props()} />);
    const count = () => container.querySelector<HTMLElement>("[data-count]")!;
    expect(count().textContent).toBe("2 of 7");
    expect(count().className).toContain("text-muted-foreground");
    expect(byLabel(container, "Find").getAttribute("aria-invalid")).toBeNull();
    for (const [text, state] of [["No results", "empty"], ["Invalid regex", "invalid"]] as const) {
      rerender(<FindBar {...props({ count: { text, state } })} />);
      expect(count().textContent).toBe(text);
      expect(count().className).toContain("text-destructive");
      expect(byLabel(container, "Find").getAttribute("aria-invalid")).toBe("true");
      expect(container.querySelector('[data-slot="input-group"]')!.className).toContain("border-destructive");
    }
    rerender(<FindBar {...props({ search: "", count: { text: "", state: "idle" } })} />);
    expect(count().textContent).toBe("");
  });

  it("hides the replace row until replace is shown", () => {
    const { container, rerender } = render(<FindBar {...props()} />);
    expect(byLabel(container, "Replace")).toBeNull();
    expect(byLabel(container, "Toggle replace").getAttribute("aria-expanded")).toBe("false");
    rerender(<FindBar {...props({ replaceVisible: true })} />);
    expect(byLabel(container, "Replace")).not.toBeNull();
    expect(byLabel(container, "Toggle replace").getAttribute("aria-expanded")).toBe("true");
  });

  it("presses the flags the query has", () => {
    const { container } = render(<FindBar {...props({ caseSensitive: true, regexp: true })} />);
    expect(byLabel(container, "Match case").getAttribute("aria-pressed")).toBe("true");
    expect(byLabel(container, "Match whole word").getAttribute("aria-pressed")).toBe("false");
    expect(byLabel(container, "Use regular expression").getAttribute("aria-pressed")).toBe("true");
  });

  it("calls each control's handler", () => {
    const p = props({ replaceVisible: true });
    const { container, getByText } = render(<FindBar {...p} />);
    fireEvent.click(byLabel(container, "Match whole word"));
    expect(p.onToggle).toHaveBeenCalledWith("wholeWord");
    fireEvent.click(byLabel(container, "Toggle replace"));
    expect(p.onToggleReplace).toHaveBeenCalledOnce();
    fireEvent.click(byLabel(container, "Previous match"));
    expect(p.onPrev).toHaveBeenCalledOnce();
    fireEvent.click(byLabel(container, "Next match"));
    expect(p.onNext).toHaveBeenCalledOnce();
    fireEvent.click(byLabel(container, "Close"));
    expect(p.onClose).toHaveBeenCalledOnce();
    fireEvent.click(getByText("Replace"));
    expect(p.onReplaceNext).toHaveBeenCalledOnce();
    fireEvent.click(getByText("Replace all"));
    expect(p.onReplaceAll).toHaveBeenCalledOnce();
    fireEvent.change(byLabel(container, "Find"), { target: { value: "bar" } });
    expect(p.onSearch).toHaveBeenCalledWith("bar");
    fireEvent.change(byLabel(container, "Replace"), { target: { value: "baz" } });
    expect(p.onReplace).toHaveBeenCalledWith("baz");
    fireEvent.keyDown(byLabel(container, "Find"), { key: "g", metaKey: true });
    expect(p.onKeyDown).toHaveBeenCalledWith(expect.any(KeyboardEvent));
  });

  it("marks the Find field for CodeMirror, keeps the buttons out of the tab order, and has no title=", () => {
    const p = props({ replaceVisible: true });
    const { container } = render(<FindBar {...p} />);
    const find = byLabel(container, "Find") as HTMLInputElement;
    expect(find.getAttribute("main-field")).toBe("true");
    expect(p.searchRef.current).toBe(find);
    expect(p.replaceRef.current).toBe(byLabel(container, "Replace"));
    for (const button of container.querySelectorAll("button")) expect(button.tabIndex).toBe(-1);
    expect(container.querySelector("[title]")).toBeNull();
  });

  it("wraps instead of squeezing at a narrow width: the inputs keep a minimum, the controls move as one group", () => {
    const { container } = render(<FindBar {...props({ replaceVisible: true, count: { text: "1 of 150", state: "ok" } })} />);
    const [findField, replaceField] = container.querySelectorAll<HTMLElement>('[data-slot="input-group"]');
    for (const field of [findField, replaceField]) {
      // The floor is the input's, so the group's floor is the input plus what sits beside it.
      expect(field.className).not.toContain("min-w-36");
      expect(field.className).toContain("min-w-fit");
      expect(field.querySelector("input")!.className).toContain("min-w-36");
      expect(field.parentElement!.className).toContain("flex-wrap");
    }
    const count = container.querySelector<HTMLElement>("[data-count]")!;
    expect(findField.contains(count)).toBe(true);
    expect(byLabel(container, "Find").contains(count)).toBe(false);
    expect(count.className).toContain("shrink-0");
    const controls = container.querySelector<HTMLElement>("[data-find-controls]")!;
    expect(controls.className).toContain("shrink-0");
    for (const label of ["Match case", "Match whole word", "Use regular expression", "Previous match", "Next match", "Close"]) {
      expect(controls.contains(byLabel(container, label))).toBe(true);
    }
  });
});
