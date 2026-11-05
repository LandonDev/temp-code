// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FieldEscape, usePageEscape } from "./pageEscape";

afterEach(cleanup);

function Page({ onClose, fields }: { onClose: () => void; fields: FieldEscape }) {
  usePageEscape(onClose, { fields });
  return (
    <div>
      <input aria-label="Name" />
      <div role="menu">
        <button>Row</button>
      </div>
      <div data-slot="select-content">
        <button>Option</button>
      </div>
      <div role="alertdialog">
        <button>Cancel</button>
      </div>
    </div>
  );
}

describe("usePageEscape", () => {
  it("leaves Escape to a confirm, a menu or a select above the page", () => {
    const onClose = vi.fn();
    const view = render(<Page onClose={onClose} fields="close" />);
    for (const name of ["Cancel", "Row", "Option"]) fireEvent.keyDown(view.getByRole("button", { name }), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("undo puts a field's value back and lets it go", () => {
    const onClose = vi.fn();
    const view = render(<Page onClose={onClose} fields="undo" />);
    const field = view.getByLabelText("Name") as HTMLInputElement;
    field.focus();
    field.value = "typed";
    fireEvent.keyDown(field, { key: "Escape" });
    expect(field.value).toBe("");
    expect(document.activeElement).not.toBe(field);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("blur keeps the text; close closes from the field", () => {
    const onBlur = vi.fn();
    const view = render(<Page onClose={onBlur} fields="blur" />);
    const field = view.getByLabelText("Name") as HTMLInputElement;
    field.focus();
    field.value = "kept";
    fireEvent.keyDown(field, { key: "Escape" });
    expect(field.value).toBe("kept");
    expect(onBlur).not.toHaveBeenCalled();
    cleanup();

    const onClose = vi.fn();
    const closing = render(<Page onClose={onClose} fields="close" />);
    const input = closing.getByLabelText("Name");
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
