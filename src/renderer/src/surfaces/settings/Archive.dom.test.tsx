// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "@shared/events";
import { DeleteThreadDialog } from "./Archive";

afterEach(cleanup);

const thread = { id: "s1", title: "Fix the rail", provider: "claude" } as SessionMeta;

describe("Delete thread confirm", () => {
  it("is one title, one line, Cancel and the destructive verb", async () => {
    const onConfirm = vi.fn();
    render(<DeleteThreadDialog thread={thread} onCancel={() => {}} onConfirm={onConfirm} />);
    const dialog = await screen.findByRole("alertdialog");
    expect(screen.getByRole("heading").textContent).toBe("Delete Fix the rail?");
    expect(dialog.textContent).toContain("The thread and its whole transcript are gone for good.");
    const verb = screen.getByRole("button", { name: "Delete thread" });
    expect(verb.dataset.variant).toBe("destructive");
    await act(async () => {
      fireEvent.click(verb);
    });
    expect(onConfirm).toHaveBeenCalledWith(thread);
  });

  it("cancels", async () => {
    const onCancel = vi.fn();
    render(<DeleteThreadDialog thread={thread} onCancel={onCancel} onConfirm={() => {}} />);
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    });
    expect(onCancel).toHaveBeenCalled();
  });

  it("is closed with no thread", () => {
    render(<DeleteThreadDialog thread={null} onCancel={() => {}} onConfirm={() => {}} />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
