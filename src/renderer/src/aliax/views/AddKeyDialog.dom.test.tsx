// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectModalShape } from "@renderer/chrome/modalShape.testkit";
import { AddKeyDialog, type AddKeyResult } from "./AddKeyDialog";

afterEach(cleanup);

function setup(submit: (input: { name?: string; key: string }) => Promise<AddKeyResult>) {
  const onOpenChange = vi.fn();
  const onAdded = vi.fn();
  const view = render(<AddKeyDialog open onOpenChange={onOpenChange} serviceName="Meta" submit={submit} onAdded={onAdded} />);
  const dialog = screen.getByRole("dialog");
  const key = within(dialog).getByLabelText("Key") as HTMLInputElement;
  const name = within(dialog).getByLabelText("Name") as HTMLInputElement;
  const add = within(dialog).getByRole("button", { name: "Add" }) as HTMLButtonElement;
  return { view, dialog, key, name, add, onOpenChange, onAdded };
}

describe("AddKeyDialog", () => {
  it("is titled for the provider, keeps the key in a password field and holds Add until the key has text", () => {
    const { dialog, key, add } = setup(vi.fn());
    expect(within(dialog).getByText("Add Meta key")).toBeTruthy();
    expect(key.type).toBe("password");
    expect(key.autocomplete).toBe("off");
    expect(add.disabled).toBe(true);
    fireEvent.change(key, { target: { value: "   " } });
    expect(add.disabled).toBe(true);
    fireEvent.change(key, { target: { value: "LLM_1607_abc" } });
    expect(add.disabled).toBe(false);
  });

  it("is the one dialog shape: Modal, a hairline footer, Cancel secondary", () => {
    const { dialog } = setup(vi.fn());
    expectModalShape(dialog);
  });

  it("verifies with a spinner, then closes and reports the saved name", async () => {
    let answer!: (r: AddKeyResult) => void;
    const submit = vi.fn(() => new Promise<AddKeyResult>((resolve) => (answer = resolve)));
    const { dialog, key, name, add, onOpenChange, onAdded } = setup(submit);
    fireEvent.change(name, { target: { value: "  Work  " } });
    fireEvent.change(key, { target: { value: " LLM_1607_abc " } });
    fireEvent.click(add);
    expect(submit).toHaveBeenCalledWith({ name: "Work", key: "LLM_1607_abc" });
    expect(add.disabled).toBe(true);
    expect(dialog.getAttribute("aria-busy")).toBe("true");
    expect(add.querySelector("[data-slot=busy-label]")?.getAttribute("data-busy")).toBe("true");
    expect(within(dialog).getByRole("button", { name: "Add" })).toBe(add);
    await act(async () => answer({ ok: true, name: "Work" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onAdded).toHaveBeenCalledWith("Work");
  });

  it("sends no name when the field is empty, and Enter in the key field adds", async () => {
    const submit = vi.fn(async (): Promise<AddKeyResult> => ({ ok: true, name: "Meta key …abcd" }));
    const { key } = setup(submit);
    fireEvent.change(key, { target: { value: "LLM_1607_abcd" } });
    await act(async () => {
      fireEvent.keyDown(key, { key: "Enter" });
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({ name: undefined, key: "LLM_1607_abcd" });
  });

  it("shows one red line for a refused key, stays open, and clears it as the key changes", async () => {
    const submit = vi.fn(async (): Promise<AddKeyResult> => ({ ok: false, error: "That key was refused by Meta" }));
    const { dialog, key, add, onOpenChange } = setup(submit);
    fireEvent.change(key, { target: { value: "LLM_1607_bad" } });
    await act(async () => {
      fireEvent.click(add);
    });
    const line = within(dialog).getByText("That key was refused by Meta");
    expect(line.className).toContain("text-destructive");
    expect(key.getAttribute("aria-invalid")).toBe("true");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(add.disabled).toBe(false);
    fireEvent.change(key, { target: { value: "LLM_1607_better" } });
    expect(within(dialog).queryByText("That key was refused by Meta")).toBeNull();
  });

  it("never shows the key back: closing and reopening starts empty", () => {
    const submit = vi.fn();
    const { view, key } = setup(submit);
    fireEvent.change(key, { target: { value: "LLM_1607_secret" } });
    view.rerender(<AddKeyDialog open={false} onOpenChange={vi.fn()} serviceName="Meta" submit={submit} onAdded={vi.fn()} />);
    view.rerender(<AddKeyDialog open onOpenChange={vi.fn()} serviceName="Meta" submit={submit} onAdded={vi.fn()} />);
    expect((within(screen.getByRole("dialog")).getByLabelText("Key") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain("LLM_1607_secret");
  });
});
