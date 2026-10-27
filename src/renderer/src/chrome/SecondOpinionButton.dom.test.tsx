// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMenus } from "./menuRows";

const h = vi.hoisted(() => ({ targets: ["codex", "cursor"] as string[], refresh: vi.fn(), probe: vi.fn() }));

vi.mock("../lib/harness/availability", () => ({
  getHarnessAvailabilitySnapshot: () => 0,
  hasProbedHarnessAvailability: () => true,
  isHarnessAvailable: () => true,
  probeHarnessAvailability: () => h.probe(),
  subscribeHarnessAvailability: () => () => {},
}));
vi.mock("../lib/harness/registry", () => ({ refreshHarnessCatalogs: (ids: string[]) => h.refresh(ids) }));
vi.mock("../lib/models", () => ({
  getModelSnapshot: () => 0,
  getPickerVisibilitySnapshot: () => 0,
  isPickerProviderVisible: () => true,
  modelsFor: (harness: string) =>
    harness === "codex"
      ? [
          { id: "gpt-a", name: "GPT A" },
          { id: "gpt-b", name: "GPT B" },
        ]
      : [],
  preferredModelId: (harness: string) => (harness === "codex" ? "gpt-a" : "auto"),
  subscribeModels: () => () => {},
  subscribePickerVisibility: () => () => {},
}));
vi.mock("../lib/secondOpinion", () => ({ secondOpinionTargets: () => h.targets }));
vi.mock("./HarnessIcon", () => ({ HarnessIcon: () => <svg data-testid="mark" /> }));

import { HandoffButton, SecondOpinionButton } from "./SecondOpinionButton";

afterEach(cleanup);
beforeEach(() => {
  resetMenus();
  h.targets = ["codex", "cursor"];
  h.refresh.mockReset();
});

async function open(name: string, menu: string) {
  fireEvent.click(screen.getByRole("button", { name }));
  return screen.findByRole("menu", { name: menu });
}

describe("SecondOpinionButton", () => {
  it("opens the providers with the line saying what it does; a provider's models sit in its submenu", async () => {
    const onPick = vi.fn();
    render(<SecondOpinionButton from="claude" onPick={onPick} />);
    const menu = await open("Second opinion", "Send this turn to another agent");
    expect(menu.textContent).toContain("Send this turn to another agent to review the work.");
    expect(h.refresh).toHaveBeenCalledWith(["codex", "cursor"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Codex" }));
    const preferred = await screen.findByRole("menuitemcheckbox", { name: "GPT A" });
    expect(preferred.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "GPT B" }));
    expect(onPick).toHaveBeenCalledWith("codex", "gpt-b");
  });

  it("a provider without a model list picks its preferred model", async () => {
    const onPick = vi.fn();
    render(<HandoffButton from="claude" onPick={onPick} />);
    const menu = await open("Hand off", "Hand this session to another agent");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Cursor" }));
    expect(onPick).toHaveBeenCalledWith("cursor", "auto");
  });

  it("Escape closes; with no other provider the button is off", async () => {
    render(<SecondOpinionButton from="claude" onPick={() => {}} />);
    const menu = await open("Second opinion", "Send this turn to another agent");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    cleanup();
    h.targets = [];
    render(<SecondOpinionButton from="claude" onPick={() => {}} />);
    expect((screen.getByRole("button", { name: "Install another provider for a second opinion" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
