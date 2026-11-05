// @vitest-environment jsdom
/**
 * The go-to pickers' frame and the markdown view toggle: the search field
 * names the picker and takes the keys, Escape closes; Preview and Source
 * are one bar of two toggles.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { PickerDialog } from "./PickerDialog";
import { MarkdownModeToggle } from "./MarkdownModeToggle";

afterEach(cleanup);

describe("PickerDialog", () => {
  it("is a dialog whose search field takes the keys, and Escape closes it", async () => {
    const onClose = vi.fn();
    const onQuery = vi.fn();
    const onSearchKey = vi.fn();
    await act(async () => {
      render(
        <PickerDialog label="Go to File" data-file-picker search={createRef()} query="" onQuery={onQuery} onSearchKey={onSearchKey} onClose={onClose}>
          <p>rows</p>
        </PickerDialog>,
      );
    });
    expect(screen.getByRole("dialog").hasAttribute("data-file-picker")).toBe(true);
    const field = screen.getByRole("textbox", { name: "Go to File" });
    fireEvent.change(field, { target: { value: "app" } });
    expect(onQuery).toHaveBeenCalledWith("app");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(onSearchKey).toHaveBeenCalled();
    await act(async () => fireEvent.keyDown(field, { key: "Escape" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("runs the rule under the field to both edges of the frame", async () => {
    await act(async () => {
      render(
        <PickerDialog label="Go to File" search={createRef()} query="" onQuery={vi.fn()} onSearchKey={vi.fn()} onClose={vi.fn()}>
          <p>rows</p>
        </PickerDialog>,
      );
    });
    const rule = document.querySelector("[data-picker-rule]")!;
    expect(rule.className).toContain("-mx-1");
    // A width of its own would pin it to the content box and leave the right end short.
    expect(rule.className).toContain("data-[orientation=horizontal]:w-auto");
  });
});

describe("MarkdownModeToggle", () => {
  it("switches between Preview and Source", () => {
    const onChange = vi.fn();
    render(<MarkdownModeToggle mode="preview" onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Preview" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(onChange).toHaveBeenCalledWith("source");
  });

  it("appears at once, as a keystroke opened it, and keeps its exit", async () => {
    await act(async () => {
      render(
        <PickerDialog label="Go to Symbol" search={createRef()} query="" onQuery={vi.fn()} onSearchKey={vi.fn()} onClose={vi.fn()}>
          <p>rows</p>
        </PickerDialog>,
      );
    });
    const classes = screen.getByRole("dialog").className.split(/\s+/);
    // Its starting style is its resting one: no fade, no scale, no rise.
    expect(classes).toEqual(expect.arrayContaining(["starting:opacity-100", "starting:scale-100", "starting:translate-y-0", "data-ending-style:opacity-0"]));
    expect(classes).not.toContain("starting:opacity-0");
    expect(classes).not.toContain("starting:scale-95");
    expect(classes.filter((c) => c.startsWith("starting:translate-y"))).toEqual(["starting:translate-y-0"]);
    const overlay = document.querySelector("[data-slot=dialog-overlay]")!.className.split(/\s+/);
    expect(overlay).toContain("starting:opacity-100");
    expect(overlay).not.toContain("starting:opacity-0");
  });
});
