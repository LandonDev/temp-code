// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DialogFooter } from "./ConfirmDialog";
import { Modal } from "./Modal";

afterEach(cleanup);

describe("DialogFooter", () => {
  it("holds Cancel while the confirm is pending, so a save in flight never closes under the person", async () => {
    const onCancel = vi.fn();
    const onClose = vi.fn();
    render(
      <Modal title="Example" busy onClose={onClose}>
        <DialogFooter pending onCancel={onCancel} confirmLabel="Save" onConfirm={vi.fn()} />
      </Modal>,
    );
    const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    fireEvent.click(cancel);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onCancel).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("offers Cancel again once the confirm settles", () => {
    render(
      <Modal title="Example" onClose={vi.fn()}>
        <DialogFooter onCancel={vi.fn()} confirmLabel="Save" onConfirm={vi.fn()} />
      </Modal>,
    );
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
