// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  doctor: null as null | ((doctor: Record<string, unknown>) => void),
  update: vi.fn(),
  installed: new Set<string>(["claude", "codex"]),
  picker: vi.fn(),
  hooks: vi.fn(),
}));

vi.mock("../../lib/tcserver/catalog", () => ({
  probeDoctor: () => new Promise((resolve) => (host.doctor = resolve)),
}));
vi.mock("../../lib/connection", () => ({
  registry: { primary: () => ({ environmentId: "local", request: (...args: unknown[]) => host.update(...args) }) },
}));
vi.mock("../../lib/harness/availability", () => ({
  getHarnessAvailabilitySnapshot: () => 0,
  subscribeHarnessAvailability: () => () => {},
  probeHarnessAvailability: async () => {},
  isHarnessAvailable: (id: string) => host.installed.has(id),
  harnessInstallCommand: (id: string) => (id === "cursor" ? "curl https://cursor.com/install | bash" : undefined),
}));
vi.mock("../../lib/harness/registry", () => ({ refreshHarnessCatalogs: async () => {} }));
vi.mock("../../lib/models", () => ({
  modelsFor: () => [{ id: "m" }],
  isPickerProviderVisible: () => true,
  savePickerProviderVisible: (...args: unknown[]) => host.picker(...args),
}));
vi.mock("../../lib/settings", () => ({ loadClaudeHooks: () => false, saveClaudeHooks: (on: boolean) => host.hooks(on) }));
vi.mock("../../chrome/HarnessIcon", () => ({ HarnessIcon: () => <svg /> }));
vi.mock("../../lib/sounds", () => ({ playCue: vi.fn() }));

const { ProvidersPage } = await import("./Providers");
const { HARNESS_TITLE } = await import("../../lib/session");

beforeEach(() => {
  host.doctor = null;
  host.update.mockReset();
  host.picker.mockReset();
  host.hooks.mockReset();
});
afterEach(cleanup);

/** The CLI's own row, in the first section; the picker section repeats the name. */
const row = (harness: "claude" | "codex" | "cursor") =>
  [...document.querySelectorAll<HTMLElement>("[data-slot=page-section]")[0].querySelectorAll<HTMLElement>("[data-slot=page-row]")].find(
    (el) => el.querySelector("[data-slot=item-title]")?.textContent === HARNESS_TITLE[harness],
  )!;

const DOCTOR = {
  claude: { found: true, version: "2.1.263 (Claude Code)", path: "/usr/local/bin/claude" },
  codex: { found: true, version: "codex-cli 0.162.1", path: "/usr/bin/codex", error: "Login expired" },
};

describe("Providers", () => {
  it("holds a skeleton in each row until the first probe answers", () => {
    render(<ProvidersPage />);
    const rows = [...document.querySelectorAll("[data-slot=page-section]")[0].querySelectorAll("[data-slot=page-row]")];
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(r.querySelector("[data-slot=skeleton]")).toBeTruthy();
  });

  it("shows the version, the path and a doctor's error", async () => {
    render(<ProvidersPage />);
    await act(async () => host.doctor?.(DOCTOR));
    expect(row("claude").textContent).toContain("v2.1.263");
    expect(row("claude").textContent).not.toContain("(Claude Code)");
    expect(within(row("claude")).getByText("/usr/local/bin/claude").className).toContain("font-mono");
    expect(row("codex").textContent).toContain("codex-cli 0.162.1");
    expect(within(row("codex")).getByText("Login expired").className).toContain("text-warning");
    expect(row("cursor").textContent).toContain("Not installed");
    expect(within(row("cursor")).getByText("curl https://cursor.com/install | bash").className).toContain("font-mono");
  });

  it("updates a CLI with a spinner, and shows a failure under its row", async () => {
    let fail: (error: Error) => void = () => {};
    host.update.mockReturnValue(new Promise((_, reject) => (fail = reject)));
    render(<ProvidersPage />);
    await act(async () => host.doctor?.(DOCTOR));
    const update = within(row("claude")).getByRole("button", { name: /Update/ });
    fireEvent.click(update);
    expect(host.update).toHaveBeenCalledWith("providers.update", { provider: "claude" });
    expect(update.querySelector("[data-slot=spinner]")).toBeTruthy();
    await act(async () => fail(new Error("npm exited 1")));
    expect(within(row("claude")).getByText("npm exited 1").closest("[data-slot=item-description]")?.className).toContain("text-destructive");
  });

  it("keeps the picker's switches in their own section, one per installed CLI", async () => {
    render(<ProvidersPage />);
    await act(async () => host.doctor?.(DOCTOR));
    const picker = screen.getByRole("region", { name: "Model picker" });
    expect(within(picker).getAllByRole("switch")).toHaveLength(2);
    expect(within(row("claude")).queryByRole("switch")).toBeNull();
    fireEvent.click(within(picker).getByRole("switch", { name: `Show ${HARNESS_TITLE.claude} in the model picker` }));
    expect(host.picker).toHaveBeenCalledWith("claude", false);
    expect(within(picker).queryByRole("switch", { name: `Show ${HARNESS_TITLE.cursor} in the model picker` })).toBeNull();
  });

  it("saves the Claude Code hooks switch", () => {
    render(<ProvidersPage />);
    fireEvent.click(screen.getByRole("switch", { name: "Run settings.json hooks" }));
    expect(host.hooks).toHaveBeenCalledWith(true);
  });
});
