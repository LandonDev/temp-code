// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Perms = { available: boolean; screen: boolean; ax: boolean };

const state = vi.hoisted(() => ({
  perms: null as Perms | null,
  settings: { enabled: false, destination: "automatic", sound: true },
  status: { loaded: true, loadError: null as string | null, writeError: null as null | { key: string; message: string } },
  load: vi.fn(async () => {}),
  set: vi.fn(),
  refresh: vi.fn(async (_prompt?: boolean) => ({})),
}));

vi.mock("../components/choice-select", async () => await import("../components/choice-select-body"));
vi.mock("../lib/sounds", () => ({ playCue: () => {} }));
vi.mock("../lib/native", () => ({ openUrl: vi.fn() }));
vi.mock("../lib/appshots", () => ({
  useAppshotSettings: () => state.settings,
  useAppshotSettingsStatus: () => state.status,
  loadAppshotSettings: () => state.load(),
  useAppshotPermissions: () => state.perms,
  setAppshotSettings: (patch: unknown) => state.set(patch),
  refreshAppshotPermissions: (prompt?: boolean) => state.refresh(prompt),
}));

const { AppshotsPage } = await import("./AppshotsSettings");

beforeEach(() => {
  state.perms = null;
  state.status = { loaded: true, loadError: null, writeError: null };
  state.load.mockClear();
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

  it("offers one Grant button, only for a missing grant, opening its System Settings pane", async () => {
    state.perms = { available: true, screen: true, ax: false };
    render(<AppshotsPage />);
    expect(screen.getByText("Granted")).toBeTruthy();
    expect(screen.getByText("Not granted").className).toContain("text-warning");
    const grants = screen.getAllByRole("button", { name: /^Grant/ });
    expect(grants.map((b) => b.getAttribute("aria-label"))).toEqual(["Grant Accessibility in System Settings"]);
    const { openUrl } = await import("../lib/native");
    fireEvent.click(grants[0]);
    expect(openUrl).toHaveBeenCalledWith(expect.stringContaining("Privacy_Accessibility"));
  });

  it("asks for a missing grant when capture turns on", async () => {
    state.perms = { available: true, screen: true, ax: false };
    render(<AppshotsPage />);
    state.refresh.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Double-⌘ capture" }));
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

  it("holds the settings in their shape until the host answers, so no default is shown or saved", () => {
    state.status = { loaded: false, loadError: null, writeError: null };
    render(<AppshotsPage />);
    expect(screen.queryByRole("switch", { name: "Shutter sound" })).toBeNull();
    expect(document.querySelectorAll("[data-slot=page-row-skeleton]")).toHaveLength(3);
  });

  it("says why the load failed, and Retry asks again", () => {
    state.status = { loaded: false, loadError: "not connected", writeError: null };
    render(<AppshotsPage />);
    expect(screen.getByText("not connected").className).toContain("text-destructive");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.load).toHaveBeenCalled();
  });

  it("puts a failed write's reason under the row that changed", () => {
    state.status = { loaded: true, loadError: null, writeError: { key: "sound", message: "host refused" } };
    render(<AppshotsPage />);
    const row = screen.getByRole("switch", { name: "Shutter sound" }).closest("[data-slot=page-row]");
    expect(row?.textContent).toContain("host refused");
  });
});
