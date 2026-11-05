// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog, ConfirmHost, confirmAction, DialogFooter } from "./ConfirmDialog";
import { Modal, useModalClose } from "./Modal";

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

  it("closeOnConfirm plays the exit, then runs the verb", async () => {
    // Whether the dialog still read open when the verb ran.
    const openWhenRun: boolean[] = [];
    const onConfirm = () => openWhenRun.push(!!document.querySelector('[role="dialog"][data-open]'));
    const view = render(
      <Modal title="Tune" onClose={vi.fn()}>
        <DialogFooter onCancel={vi.fn()} confirmLabel="Save" closeOnConfirm onConfirm={onConfirm} />
      </Modal>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(openWhenRun).toEqual([false]));
    view.unmount();

    // Without it, the verb runs while the dialog is still open.
    openWhenRun.length = 0;
    render(
      <Modal title="Tune" onClose={vi.fn()}>
        <DialogFooter onCancel={vi.fn()} confirmLabel="Save" onConfirm={onConfirm} />
      </Modal>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(openWhenRun).toEqual([true]);
  });
});

function CloseTwice({ first, second }: { first: () => void; second: () => void }) {
  const close = useModalClose()!;
  return (
    <button
      type="button"
      onClick={() => {
        close(first);
        close(second);
      }}
    >
      Both
    </button>
  );
}

const verbOf = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === name) as HTMLButtonElement | undefined;

describe("a dialog's exit", () => {
  it("lets the first close win: a Cancel during a confirm's exit never replaces the verb", async () => {
    const first = vi.fn();
    const second = vi.fn();
    render(
      <Modal title="Pause all" onClose={vi.fn()}>
        <CloseTwice first={first} second={second} />
      </Modal>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Both" }));
    await waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    expect(second).not.toHaveBeenCalled();
  });

  it("keeps the verb spinning through the exit once onConfirm lands, then runs onDone", async () => {
    // Whether the verb and Cancel still waited when the exit ended.
    const heldAtDone: (boolean | undefined)[] = [];
    const onDone = () => heldAtDone.push(verbOf("Delete")?.disabled, verbOf("Cancel")?.disabled);
    render(<ConfirmDialog title="Delete it?" confirmLabel="Delete" danger onCancel={vi.fn()} onConfirm={async () => {}} onDone={onDone} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });
    await waitFor(() => expect(heldAtDone).toEqual([true, true]));
  });

  it("ConfirmHost answers the verb at once and drops the dialog only after its exit", async () => {
    render(<ConfirmHost />);
    let drawnWhenAnswered: boolean | undefined;
    await act(async () => {
      void confirmAction({ title: "Stop all?", action: "Stop all", danger: true }).then(() => {
        drawnWhenAnswered = document.querySelector('[role="alertdialog"]') !== null;
      });
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Stop all" }));
    });
    await waitFor(() => expect(drawnWhenAnswered).toBe(true));
    await waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
  });

  it("ConfirmHost answers Cancel with false after the exit", async () => {
    render(<ConfirmHost />);
    let answer: boolean | undefined;
    await act(async () => {
      void confirmAction({ title: "Stop all?", action: "Stop all" }).then((ok) => (answer = ok));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    });
    await waitFor(() => expect(answer).toBe(false));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});
