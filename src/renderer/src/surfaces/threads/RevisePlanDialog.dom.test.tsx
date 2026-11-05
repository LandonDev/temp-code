// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectModalShape } from "../../chrome/modalShape.testkit";
import { RevisePlanDialog } from "./RevisePlanDialog";

afterEach(cleanup);

describe("RevisePlanDialog", () => {
  it("is the one dialog shape, Send holding its width while it sends", async () => {
    let finish: () => void = () => {};
    const onSend = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const onOpenChange = vi.fn();
    render(<RevisePlanDialog open onOpenChange={onOpenChange} onSend={onSend} />);
    const dialog = screen.getByRole("dialog");
    expectModalShape(dialog);
    fireEvent.change(screen.getByLabelText("What should change"), { target: { value: "  Split milestone 2  " } });
    fireEvent.keyDown(screen.getByLabelText("What should change"), { key: "Enter", ctrlKey: true });
    expect(onSend).toHaveBeenCalledWith("Split milestone 2");
    const send = dialog.querySelector("[data-dialog-confirm]")!;
    expect(send.querySelector("[data-slot=busy-label]")?.getAttribute("data-busy")).toBe("true");
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("says a failure as the dialog's error line and stays open", async () => {
    const onSend = vi.fn(() => Promise.reject(new Error("the thread is gone")));
    const onOpenChange = vi.fn();
    render(<RevisePlanDialog open onOpenChange={onOpenChange} onSend={onSend} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(screen.getByText("the thread is gone").className).toContain("text-destructive");
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
