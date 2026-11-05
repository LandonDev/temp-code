// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MoveNotice } from "../lib/threadMove";
import { toast } from "sonner";

const moves = vi.hoisted(() => ({ notices: [] as MoveNotice[], move: null as null | ((...args: unknown[]) => Promise<unknown>) }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn() }) }));

vi.mock("../lib/threadMove", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/threadMove")>()),
  useMoveNotices: () => moves.notices.map((notice) => ({ ...notice })),
  previewMove: async () => ({ branch: "ios/home", detached: false, worktree: false, dirty: 3, origin: true }),
  moveThread: (...args: unknown[]) => moves.move!(...args),
}));

import { MoveThreadConfirm, MoveToasts } from "./ThreadHostChip";

afterEach(() => {
  cleanup();
  moves.notices = [];
  vi.clearAllMocks();
});

describe("the move confirm", () => {
  it("says what travels as one comma run of facts, never a middle dot or space alone", async () => {
    render(<MoveThreadConfirm sessionId="s1" to="env_box" toName="box" fromName="This Mac" onClose={() => {}} />);
    const branch = await screen.findByText("Branch ios/home travels too");
    const line = branch.parentElement!;
    expect(Array.from(line.children, (c) => c.textContent)).toEqual(["Branch ios/home travels too", "3 uncommitted files travel too"]);
    expect(screen.getByText("Its subagents and pages move with it; undo history stays on This Mac.")).toBeTruthy();
    expect(line.dataset.slot).toBe("facts");
    expect(document.querySelector("[data-confirm-note]")?.textContent).not.toContain("·");
  });
});


describe("the move confirm's verb", () => {
  it("runs the move inside the confirm: a refusal is its red line, never a toast, and the confirm stays", async () => {
    moves.move = vi.fn(async () => {
      throw new Error("box is offline");
    });
    const onClose = vi.fn();
    render(<MoveThreadConfirm sessionId="s1" to="env_box" toName="box" fromName="This Mac" onClose={onClose} />);
    await screen.findByText("Branch ios/home travels too");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Move thread" }));
    });
    expect(moves.move).toHaveBeenCalledWith("s1", "env_box", { toastRefusal: false });
    expect(within(screen.getByRole("alertdialog")).getByText("box is offline")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes through its exit once the move lands", async () => {
    moves.move = vi.fn(async () => ({}));
    const onClose = vi.fn();
    render(<MoveThreadConfirm sessionId="s1" to="env_box" toName="box" fromName="This Mac" onClose={onClose} />);
    await screen.findByText("Branch ios/home travels too");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Move thread" }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe("MoveToasts", () => {
  it("skips unchanged visible fields, updates one changed move and dismisses removed and unmounted moves", async () => {
    const notice: MoveNotice = { key: 1, sessionId: "s1", title: "Review", fromName: "This Mac", toName: "box", result: null, error: "Link down" };
    moves.notices = [notice, { ...notice, key: 2, sessionId: "s2", error: null }];
    const view = render(<MoveToasts />);
    await act(() => Promise.resolve());
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledTimes(1);
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast).mockClear();
    moves.notices = [{ ...notice, error: "Link down\nMore detail" }, moves.notices[1]];
    view.rerender(<MoveToasts />);
    await act(() => Promise.resolve());
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    moves.notices = [{ ...notice, error: "Try again" }];
    view.rerender(<MoveToasts />);
    await act(() => Promise.resolve());
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(`Couldn't move "Review" to box`, expect.objectContaining({ id: "move:1", description: "Try again" }));
    expect(toast.dismiss).toHaveBeenCalledExactlyOnceWith("move:2");
    vi.mocked(toast.dismiss).mockClear();
    view.unmount();
    expect(toast.dismiss).toHaveBeenCalledExactlyOnceWith("move:1");
  });
});
