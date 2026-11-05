// @vitest-environment jsdom
/**
 * The goal dialog: the thread menu's Goal… opens it for its own thread
 * only; Set and Update call setGoal, Clear shows only while a goal runs,
 * Enter sets and Shift+Enter does not. The host mounts the body from the
 * dialogs chunk.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { expectModalShape } from "./modalShape.testkit";

const { setGoal, clearGoal } = vi.hoisted(() => ({
  setGoal: vi.fn((): Promise<void> => Promise.resolve()),
  clearGoal: vi.fn(() => Promise.resolve()),
}));
vi.mock("../lib/tcserver/commands", () => ({ setGoal, clearGoal }));
/** A thread no composer has loaded: its goal is on its meta alone. */
vi.mock("../lib/tcserver/store", () => ({
  useSession: () => undefined,
  useSessionMeta: (id: string | null) => (id === "off-screen" ? { id, goal: { condition: "the rail is fixed", iterations: 1, setAt: 1 } } : null),
}));

import { GoalDialogHost, goalDialog } from "./GoalDialog";
import { GoalDialog } from "./GoalDialogBody";

afterEach(() => {
  act(() => goalDialog.close());
  cleanup();
  setGoal.mockClear();
  clearGoal.mockClear();
});

const goal = { condition: "tests pass", iterations: 3 } as never;

describe("GoalDialog", () => {
  it("is the one dialog shape: Clear at the footer's start while a goal runs", () => {
    render(<GoalDialog sessionId="a" goal={goal} />);
    act(() => goalDialog.open("a"));
    const dialog = screen.getByRole("dialog");
    expectModalShape(dialog);
    expect(screen.getByRole("button", { name: "Clear" }).closest("[data-footer-start]")).not.toBeNull();
  });

  it("says a refused goal in the dialog and stays open; Escape waits while it is sent", async () => {
    let refuse: (e: Error) => void = () => {};
    setGoal.mockImplementationOnce(() => new Promise<void>((_, reject) => (refuse = reject)));
    render(<GoalDialog sessionId="a" />);
    act(() => goalDialog.open("a"));
    fireEvent.change(screen.getByRole("textbox", { name: "Goal" }), { target: { value: "ship it" } });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    expect(screen.getByRole("dialog").getAttribute("aria-busy")).toBe("true");
    fireEvent.keyDown(document.body, { key: "Escape" });
    await act(async () => refuse(new Error("not connected")));
    expect(screen.getByText("not connected").className).toContain("text-destructive");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("spins Clear while it runs, never Set", async () => {
    let land: () => void = () => {};
    clearGoal.mockImplementationOnce(() => new Promise<void>((resolve) => (land = resolve)));
    render(<GoalDialog sessionId="a" goal={goal} />);
    act(() => goalDialog.open("a"));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    const busyOf = (name: string) => screen.getByRole("button", { name }).querySelector("[data-slot=busy-label]")?.hasAttribute("data-busy");
    expect(busyOf("Clear")).toBe(true);
    expect(busyOf("Update")).toBe(false);
    await act(async () => land());
  });

  it("opens for its own thread only", () => {
    render(
      <>
        <GoalDialog sessionId="a" />
        <GoalDialog sessionId="b" />
      </>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => goalDialog.open("b"));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("Set calls setGoal; there is no Clear without a goal", async () => {
    render(<GoalDialog sessionId="a" />);
    act(() => goalDialog.open("a"));
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Goal" }), { target: { value: "ship it" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Set" })));
    expect(setGoal).toHaveBeenCalledWith("a", "ship it");
  });

  it("a running goal reads Update, offers Clear and says how often it was checked", async () => {
    render(<GoalDialog sessionId="a" goal={goal} />);
    act(() => goalDialog.open("a"));
    expect((screen.getByRole("textbox", { name: "Goal" }) as HTMLTextAreaElement).value).toBe("tests pass");
    expect(screen.getByText("Checked 3 times")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update" }).hasAttribute("disabled")).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Clear" })));
    expect(clearGoal).toHaveBeenCalledWith("a");
  });

  it("Enter sets, Shift+Enter does not", async () => {
    render(<GoalDialog sessionId="a" />);
    act(() => goalDialog.open("a"));
    const field = screen.getByRole("textbox", { name: "Goal" });
    fireEvent.change(field, { target: { value: "green" } });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(setGoal).not.toHaveBeenCalled();
    await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
    expect(setGoal).toHaveBeenCalledWith("a", "green");
  });

  it("the app's one host answers Goal… for a thread with no composer mounted, from its meta's goal", async () => {
    render(<GoalDialogHost />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => goalDialog.open("off-screen"));
    // The body rides the dialogs chunk: the first open waits for it.
    await screen.findByRole("textbox", { name: "Goal" }, { timeout: 10_000 });
    expect((screen.getByRole("textbox", { name: "Goal" }) as HTMLTextAreaElement).value).toBe("the rail is fixed");
    expect(screen.getByText("Checked once")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Clear" })));
    expect(clearGoal).toHaveBeenCalledWith("off-screen");
    act(() => goalDialog.open("another"));
    expect((screen.getByRole("textbox", { name: "Goal" }) as HTMLTextAreaElement).value).toBe("");
  });
});
