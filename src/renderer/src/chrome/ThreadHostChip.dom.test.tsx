// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/threadMove", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/threadMove")>()),
  previewMove: async () => ({ branch: "ios/home", detached: false, worktree: false, dirty: 3, origin: true }),
}));

import { MoveThreadConfirm } from "./ThreadHostChip";

afterEach(cleanup);

describe("the move confirm", () => {
  it("says what travels as one fact per element, set apart by margin, never a middle dot", async () => {
    render(<MoveThreadConfirm sessionId="s1" to="env_box" toName="box" fromName="This Mac" onClose={() => {}} />);
    const branch = await screen.findByText("Branch ios/home travels too");
    const line = branch.parentElement!;
    expect(Array.from(line.children, (c) => c.textContent)).toEqual(["Branch ios/home travels too", "3 uncommitted files travel too"]);
    expect(screen.getByText("Its subagents and pages move with it; undo history stays on This Mac.")).toBeTruthy();
    expect(line.className).toContain("gap-x-2");
    expect(document.querySelector("[data-confirm-note]")?.textContent).not.toContain("·");
  });
});
