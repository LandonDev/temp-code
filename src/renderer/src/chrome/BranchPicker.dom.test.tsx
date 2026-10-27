// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMenus } from "./menuRows";

const h = vi.hoisted(() => ({ checkout: vi.fn(), create: vi.fn() }));

vi.mock("../lib/connection", () => ({ registry: { primary: () => ({ environmentId: "local" }) } }));
vi.mock("../lib/tcserver/projects", () => ({ environmentOfCwd: () => "local" }));
vi.mock("../hooks/useProjectBranches", () => ({
  useProjectBranchesState: () => ({
    settled: true,
    branches: {
      current: "main",
      detached: false,
      branches: [
        { name: "main", current: true, remote: null },
        { name: "feature", current: false, remote: null },
        { name: "fix", current: false, remote: "origin" },
      ],
    },
  }),
}));
vi.mock("../lib/fs", () => ({
  gitCheckout: (...args: unknown[]) => h.checkout(...args),
  gitCreateBranch: (...args: unknown[]) => h.create(...args),
  gitCommit: vi.fn(),
  gitStageAll: vi.fn(),
  gitStash: vi.fn(),
  isCheckoutBlockedByChanges: () => false,
  notifyGitChanged: vi.fn(),
}));

import { BranchPicker } from "./BranchPicker";

afterEach(cleanup);
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  resetMenus();
  h.checkout.mockReset().mockResolvedValue(undefined);
  h.create.mockReset().mockResolvedValue(undefined);
});

async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Branch main" }));
  return screen.findByRole("dialog", { name: "Branch picker" });
}

describe("BranchPicker", () => {
  it("the head form is the branch name alone in 13px medium type, and opens the same list", async () => {
    render(<BranchPicker cwd="/u/me/app" variant="head" tip="Tracks origin/main" />);
    const trigger = screen.getByRole("button", { name: "Branch main" });
    expect(trigger.querySelector("svg")).toBeNull();
    expect(trigger.className).toContain("text-[13px]");
    expect(trigger.className).toContain("font-medium");
    const picker = await open();
    expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual(["main", "feature", "fixorigin"]);
  });

  it("opens with the search field focused and the branches as rows, the current one selected", async () => {
    render(<BranchPicker cwd="/u/me/app" />);
    const picker = await open();
    const search = within(picker).getByRole("textbox", { name: "Search or create a branch" });
    await waitFor(() => expect(document.activeElement).toBe(search));
    const options = within(picker).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["main", "feature", "fixorigin"]);
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("arrow keys move the highlight and Enter checks the branch out", async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(<BranchPicker cwd="/u/me/app" onChange={onChange} onClose={onClose} />);
    const picker = await open();
    const search = within(picker).getByRole("textbox");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "ArrowUp" });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(h.checkout).toHaveBeenCalledWith("local", "/u/me/app", "feature", null));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it("a name no branch has offers to create it; a click on it creates", async () => {
    render(<BranchPicker cwd="/u/me/app" />);
    const picker = await open();
    fireEvent.change(within(picker).getByRole("textbox"), { target: { value: "new-thing" } });
    fireEvent.click(within(picker).getByRole("option", { name: "Create and checkout new-thing" }));
    await waitFor(() => expect(h.create).toHaveBeenCalledWith("local", "/u/me/app", "new-thing"));
  });

  it("Escape closes and hands the focus back", async () => {
    const onClose = vi.fn();
    render(<BranchPicker cwd="/u/me/app" onClose={onClose} />);
    const picker = await open();
    fireEvent.keyDown(within(picker).getByRole("textbox"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Branch picker" })).toBeNull());
    expect(onClose).toHaveBeenCalled();
  });
});
