// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog, ConfirmHost, DialogFooter, confirmAction } from "./ConfirmDialog";
import { Modal } from "./Modal";

afterEach(cleanup);

describe("Modal", () => {
  it("names the dialog, its description and the close action", () => {
    render(
      <Modal title="Example" description="A reusable shell" onClose={vi.fn()}>
        Body
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("data-slot")).toBe("dialog-content");
    expect(dialog.textContent).toContain("Example");
    expect(dialog.textContent).toContain("A reusable shell");
    expect(dialog.textContent).toContain("Body");
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("enters on the dialog's motion: 240ms in, 120ms out", () => {
    render(
      <Modal title="Example" onClose={vi.fn()}>
        Body
      </Modal>,
    );
    const classes = screen.getByRole("dialog").className;
    expect(classes).toContain("duration-(--dur-slow)");
    expect(classes).toContain("data-closed:duration-(--dur-fast)");
    expect(classes).toContain("data-open:slide-in-from-bottom-1");
  });

  it("closes from the close button and from Escape, after its exit", async () => {
    const onClose = vi.fn();
    render(
      <Modal title="Example" onClose={onClose}>
        Body
      </Modal>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    cleanup();
    const onEscape = vi.fn();
    render(
      <Modal title="Example" onClose={onEscape}>
        Body
      </Modal>,
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(onEscape).toHaveBeenCalledTimes(1));
  });

  it("hands initialFocus to the popup", async () => {
    function WithField() {
      const field = useRef<HTMLInputElement>(null);
      return (
        <Modal title="Rename" onClose={vi.fn()} initialFocus={field}>
          <input ref={field} aria-label="Name" />
        </Modal>
      );
    }
    render(<WithField />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Name")));
  });

  it("waits while busy", async () => {
    const onClose = vi.fn();
    render(
      <Modal title="Example" busy onClose={onClose}>
        Body
      </Modal>,
    );
    expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("runs a footer's Cancel after the exit", async () => {
    const onClose = vi.fn();
    const onCancel = vi.fn();
    render(
      <Modal title="Example" onClose={onClose}>
        <DialogFooter onCancel={onCancel} confirmLabel="Save" onConfirm={vi.fn()} />
      </Modal>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("ConfirmDialog", () => {
  it("is an alert dialog with the verb in the button kit", () => {
    render(<ConfirmDialog title="Delete it?" body="Gone for good." confirmLabel="Delete" danger onCancel={vi.fn()} onConfirm={vi.fn()} />);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Gone for good.");
    expect(screen.getByRole("button", { name: "Delete" }).getAttribute("data-variant")).toBe("destructive");
  });

  it("shows a rejected confirm inline and stays open", async () => {
    render(
      <ConfirmDialog
        title="Delete it?"
        body="Gone for good."
        confirmLabel="Delete"
        onCancel={vi.fn()}
        onConfirm={() => Promise.reject(new Error("disk full"))}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("disk full")).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });
});

describe("confirmAction", () => {
  it("resolves true on the verb and false on Cancel, one request at a time", async () => {
    render(<ConfirmHost />);
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = confirmAction({ title: "Close this tab?", action: "Close", danger: true });
      second = confirmAction({ title: "Delete “notes.md”?", action: "Delete", danger: true });
    });
    expect(screen.getByRole("alertdialog").textContent).toContain("Close this tab?");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await expect(first).resolves.toBe(true);

    expect((await screen.findByRole("alertdialog")).textContent).toContain("Delete “notes.md”?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(second).resolves.toBe(false);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});
