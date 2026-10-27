// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registry, type Link } from "../lib/connection";
import { NewThreadChooser } from "./NewThreadChooser";

// The tune view's rules come from the host; with none loaded it shows the instructions field alone.
vi.mock("../lib/tcserver/rules", () => ({ useRulesScope: () => ({ scope: undefined, catalog: null }) }));
vi.mock("../lib/tcserver/workspaces", () => ({ useWorkspaces: () => [] }));

beforeEach(() => {
  vi.spyOn(registry, "primary").mockReturnValue({ environmentId: "local" } as Link);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

describe("NewThreadChooser", () => {
  it("is an icon button named New thread that opens a row per thread type", async () => {
    render(<NewThreadChooser workspaceId={null} empty={false} onStart={() => {}} />);
    const trigger = screen.getByRole("button", { name: "New thread" });
    expect(trigger.textContent).toBe("");
    expect(trigger.getAttribute("data-tauri-drag-region")).toBe("false");
    await click(trigger);
    const titles = [...(await screen.findByRole("dialog")).querySelectorAll("[data-slot=item-title]")];
    expect(titles.map((t) => t.textContent)).toEqual([
      "Chat",
      "Plan",
      "Plan the project…",
      "Implement",
      "Orchestrate",
      "Research",
    ]);
  });

  it("starts the picked type with no rules", async () => {
    const onStart = vi.fn();
    render(<NewThreadChooser workspaceId={null} empty={false} onStart={onStart} />);
    await click(screen.getByRole("button", { name: "New thread" }));
    await click(await screen.findByRole("button", { name: /^Implement/ }));
    expect(onStart).toHaveBeenCalledWith("implementation", null);
  });

  it("opens a tunable type's options in place and starts it with the rules", async () => {
    const onStart = vi.fn();
    render(<NewThreadChooser workspaceId={null} empty={false} onStart={onStart} />);
    await click(screen.getByRole("button", { name: "New thread" }));
    // Only the two tunable types carry an options button.
    expect(screen.queryByRole("button", { name: "Chat options" })).toBeNull();
    expect(screen.getByRole("button", { name: "Orchestrate options" })).toBeTruthy();
    await click(screen.getByRole("button", { name: "Research options" }));

    expect(screen.getByText("Research options")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Chat/ })).toBeNull();
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Custom instructions for this run…"), {
        target: { value: "  cite every claim  " },
      });
    });
    await click(screen.getByRole("button", { name: "Start research" }));
    expect(onStart).toHaveBeenCalledWith("research", { instructions: "cite every claim" });
  });

  it("goes back from the options to the list", async () => {
    render(<NewThreadChooser workspaceId={null} empty={false} onStart={() => {}} />);
    await click(screen.getByRole("button", { name: "New thread" }));
    await click(screen.getByRole("button", { name: "Orchestrate options" }));
    await click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: /^Chat/ })).toBeTruthy();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Orchestrate options");
  });

  it("says New thread in words when the strip is empty", () => {
    render(<NewThreadChooser workspaceId={null} empty onStart={() => {}} />);
    expect(screen.getByRole("button", { name: "New thread" }).textContent).toBe("New thread");
  });

  it("renders nothing for a workspace this window does not know", () => {
    const { container } = render(<NewThreadChooser workspaceId="ws_gone" empty={false} onStart={() => {}} />);
    expect(container.innerHTML).toBe("");
  });
});
