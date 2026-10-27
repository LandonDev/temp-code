// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Perms = { available: boolean; screen: boolean; ax: boolean };

const state = vi.hoisted(() => ({
  perms: null as Perms | null,
  settings: { enabled: false, destination: "automatic", sound: true },
  set: vi.fn(),
  refresh: vi.fn(async (_prompt?: boolean) => ({})),
}));

vi.mock("../lib/sounds", () => ({ playCue: () => {} }));
vi.mock("../lib/native", () => ({ openUrl: vi.fn() }));
vi.mock("../lib/appshots", () => ({
  useAppshotSettings: () => state.settings,
  useAppshotPermissions: () => state.perms,
  setAppshotSettings: (patch: unknown) => state.set(patch),
  refreshAppshotPermissions: (prompt?: boolean) => state.refresh(prompt),
}));

const { AppshotsPage } = await import("./AppshotsSettings");

beforeEach(() => {
  state.perms = null;
  state.set.mockClear();
  state.refresh.mockClear();
});
afterEach(cleanup);

describe("Appshots page", () => {
  it("says it needs macOS when the helper is missing", () => {
    state.perms = { available: false, screen: false, ax: false };
    render(<AppshotsPage />);
    expect(screen.getByText("Appshots need macOS")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("shows skeletons while the grants are unknown", () => {
    render(<AppshotsPage />);
    expect(screen.getAllByTestId("permission-skeleton")).toHaveLength(2);
  });

  it("offers Grant and System Settings only for a missing grant", () => {
    state.perms = { available: true, screen: true, ax: false };
    render(<AppshotsPage />);
    expect(screen.getByText("Granted")).toBeTruthy();
    expect(screen.getByText("Not granted").className).toContain("text-warning");
    expect(screen.getAllByRole("button", { name: "Grant" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "System Settings" })).toHaveLength(1);
  });

  it("asks for a missing grant when capture turns on", async () => {
    state.perms = { available: true, screen: true, ax: false };
    render(<AppshotsPage />);
    state.refresh.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Capture on double-⌘" }));
    });
    expect(state.set).toHaveBeenCalledWith({ enabled: true });
    expect(state.refresh).toHaveBeenCalledWith(true);
  });

  it("saves the destination", async () => {
    state.perms = { available: true, screen: true, ax: true };
    render(<AppshotsPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("combobox", { name: "Destination" }));
    });
    const option = await screen.findByRole("option", { name: "New chat" });
    await act(async () => {
      fireEvent.pointerDown(option, { pointerType: "mouse" });
      fireEvent.click(option);
    });
    expect(state.set).toHaveBeenCalledWith({ destination: "new-chat" });
  });
});
