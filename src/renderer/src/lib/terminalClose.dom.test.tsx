// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmHost } from "../chrome/ConfirmDialog";
import { newTerminalFile } from "./layout";
import { confirmCloseTerminal } from "./terminalClose";

vi.mock("./pty", () => ({
  getPtyStatus: async () => ({ foreground: "bun dev" }),
}));

afterEach(cleanup);

describe("confirmCloseTerminal in the app", () => {
  it("asks in the app's alert dialog: Cancel keeps the terminal, Close closes it", async () => {
    render(<ConfirmHost />);
    const file = newTerminalFile("/repo", "dev");

    const kept = confirmCloseTerminal(file);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Close dev?");
    expect(dialog.textContent).toContain("bun dev is still running.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(kept).resolves.toBe(false);

    const closed = confirmCloseTerminal(file);
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await expect(closed).resolves.toBe(true);
  });
});
