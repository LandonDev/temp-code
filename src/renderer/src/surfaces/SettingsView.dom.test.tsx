// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stub = (name: string) => () => <div data-page={name} />;
vi.mock("./settings/General", () => ({ GeneralPage: stub("general") }));
vi.mock("./settings/ThreadDefaults", () => ({ ThreadDefaultsPage: stub("defaults") }));
vi.mock("./settings/Appearance", () => ({ AppearancePage: stub("appearance") }));
vi.mock("./settings/Editor", () => ({ EditorPage: stub("editor") }));
vi.mock("./settings/Keybindings", () => ({ KeybindingsPage: stub("keybindings") }));
vi.mock("./settings/Providers", () => ({ ProvidersPage: stub("providers") }));
vi.mock("./settings/Workspace", () => ({ WorkspacePage: stub("workspace") }));
vi.mock("./settings/Orchestration", () => ({ OrchestrationPage: stub("orchestration") }));
vi.mock("./settings/Build", () => ({ BuildPage: stub("build") }));
vi.mock("./settings/Archive", () => ({ ArchivePage: stub("archive") }));
vi.mock("./ReviewSettings", () => ({ ReviewsPage: stub("reviews") }));
vi.mock("./AppshotsSettings", () => ({ AppshotsPage: stub("appshots") }));
vi.mock("./RemoteSettings", () => ({ RemoteSettings: stub("remote") }));
vi.mock("./EnvironmentsSettings", () => ({ EnvironmentsSettings: stub("environments") }));
vi.mock("../lib/tcserver/workspaces", () => ({ useWorkspaces: () => [] }));
vi.mock("../lib/nativeWeb", () => ({ isWebMode: () => false }));
vi.mock("../chrome/WindowControls", () => ({ WindowControls: () => null }));

const { SettingsView } = await import("./SettingsView");
const { shell, shellStore } = await import("../stores/shell");

const noop = () => {};
const view = () => (
  <SettingsView
    cwd="/tmp"
    onOpenSession={noop}
    onArchiveSession={noop}
    onDeleteSession={noop}
    onOpenWhatsNew={noop}
  />
);

beforeEach(() => {
  act(() => shell.openSettings("general"));
});
afterEach(cleanup);

describe("SettingsView", () => {
  it("names the page once, with its description under it", () => {
    render(view());
    expect(screen.getAllByText("General")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("General");
    expect(screen.getByText("How the app behaves, and the release you run.")).toBeTruthy();
  });

  it("shows Hosts with both bodies on the desktop", () => {
    act(() => shell.openSettings("remote"));
    render(view());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Hosts");
    expect(document.querySelector("[data-page=remote]")).toBeTruthy();
    expect(document.querySelector("[data-page=environments]")).toBeTruthy();
  });

  it("closes on Escape", () => {
    render(view());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(shellStore.getState().settingsOpen).toBe(false);
  });

  it("leaves Escape to a dialog that has focus", () => {
    render(
      <>
        {view()}
        <div role="dialog">
          <input aria-label="Name" />
        </div>
      </>,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "Escape" });
    expect(shellStore.getState().settingsOpen).toBe(true);
  });
});
