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
});

describe("MarkdownModeToggle", () => {
  it("switches between Preview and Source", () => {
    const onChange = vi.fn();
    render(<MarkdownModeToggle mode="preview" onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Preview" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(onChange).toHaveBeenCalledWith("source");
  });
});
