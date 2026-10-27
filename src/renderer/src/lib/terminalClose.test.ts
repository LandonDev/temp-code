import { afterEach, describe, expect, it, vi } from "vitest";
import { newTerminalFile } from "./layout";
import { closeTerminalsRequest, confirmCloseTerminal, confirmCloseTerminals } from "./terminalClose";

const getPtyStatus = vi.fn();
const confirmAction = vi.fn();

vi.mock("./pty", () => ({
  getPtyStatus: (...args: unknown[]) => getPtyStatus(...args),
}));

vi.mock("../chrome/ConfirmDialog", () => ({
  confirmAction: (...args: unknown[]) => confirmAction(...args),
}));

afterEach(() => {
  getPtyStatus.mockReset();
  confirmAction.mockReset();
});

describe("confirmCloseTerminal", () => {
  it("allows close when only the shell is foreground", async () => {
    const file = newTerminalFile("/repo");
    getPtyStatus.mockResolvedValue({ foreground: null });
    await expect(confirmCloseTerminal(file)).resolves.toBe(true);
    expect(getPtyStatus).toHaveBeenCalledWith(file.id);
    expect(confirmAction).not.toHaveBeenCalled();
  });

  it("asks with the terminal's name and its process when one is running", async () => {
    const file = newTerminalFile("/repo", "agent-terminal");
    getPtyStatus.mockResolvedValue({ foreground: "npm" });
    confirmAction.mockResolvedValue(false);
    await expect(confirmCloseTerminal(file)).resolves.toBe(false);
    expect(confirmAction).toHaveBeenCalledWith({
      title: "Close agent-terminal?",
      body: "npm is still running.",
      action: "Close",
      danger: true,
    });
  });
});

describe("confirmCloseTerminals", () => {
  it("summarizes several running terminals and skips idle ones", async () => {
    const first = newTerminalFile("/repo", "dev");
    const second = newTerminalFile("/repo", "test");
    const idle = newTerminalFile("/repo", "idle");
    getPtyStatus.mockImplementation(async (id: string) => {
      if (id === first.id) return { foreground: "vite" };
      if (id === second.id) return { foreground: "jest" };
      return { foreground: null };
    });
    confirmAction.mockResolvedValue(true);
    await expect(confirmCloseTerminals([first, second, idle])).resolves.toBe(true);
    expect(confirmAction).toHaveBeenCalledWith({
      title: "Close 2 terminals?",
      body: "vite and 1 more are still running.",
      action: "Close",
      danger: true,
    });
  });

  it("asks nothing when every terminal is idle or gone", async () => {
    getPtyStatus.mockResolvedValueOnce({ foreground: " " }).mockRejectedValueOnce(new Error("gone"));
    await expect(confirmCloseTerminals([newTerminalFile("/repo"), newTerminalFile("/repo")])).resolves.toBe(true);
    expect(confirmAction).not.toHaveBeenCalled();
  });
});

describe("closeTerminalsRequest", () => {
  it("is a title and one line, no list: the first process and how many more", () => {
    const file = newTerminalFile("/repo", "dev");
    const running = ["bun dev", "vite", "jest"].map((process) => ({ file, process }));
    expect(closeTerminalsRequest(running)).toMatchObject({
      title: "Close 3 terminals?",
      body: "bun dev and 2 more are still running.",
    });
  });
});
