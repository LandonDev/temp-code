// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  doctor: null as null | ((doctor: Record<string, unknown>) => void),
  update: vi.fn(),
  installed: new Set<string>(["claude", "codex"]),
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
vi.mock("../../lib/models", () => ({ modelsFor: () => [{ id: "m" }] }));
vi.mock("../../chrome/HarnessIcon", () => ({ HarnessIcon: () => <svg /> }));
vi.mock("../../lib/sounds", () => ({ playCue: vi.fn() }));

const { ProvidersPage } = await import("./Providers");
const { HARNESS_TITLE } = await import("../../lib/session");

beforeEach(() => {
  host.doctor = null;
  host.update.mockReset();
});
afterEach(cleanup);

/** The CLI's own row. */
const row = (harness: "claude" | "codex" | "cursor") =>
  [...document.querySelectorAll<HTMLElement>("[data-slot=page-row]")].find(
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

  it("shows the version or Not installed and a doctor's error, never the path or the install line", async () => {
    render(<ProvidersPage />);
    await act(async () => host.doctor?.(DOCTOR));
    expect(row("claude").textContent).toContain("v2.1.263");
    expect(row("claude").textContent).not.toContain("(Claude Code)");
    expect(document.body.textContent).not.toContain("/usr/local/bin/claude");
    expect(row("codex").textContent).toContain("codex-cli 0.162.1");
    expect(within(row("codex")).getByText("Login expired").className).toContain("text-warning");
    expect(row("cursor").textContent).toContain("Not installed");
    expect(document.body.textContent).not.toContain("cursor.com/install");
  });

  it("gives a missing CLI one control that copies its install command", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<ProvidersPage />);
    await act(async () => host.doctor?.(DOCTOR));
    const buttons = within(row("cursor")).getAllByRole("button");
    expect(buttons).toHaveLength(1);
    await act(async () => {
      fireEvent.click(within(row("cursor")).getByRole("button", { name: "Copy install command" }));
    });
    expect(writeText).toHaveBeenCalledWith("curl https://cursor.com/install | bash");
    expect(within(row("claude")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Update"]);
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

  it("leaves the model picker and the hooks to Thread defaults", async () => {
    render(<ProvidersPage />);
    await act(async () => host.doctor?.(DOCTOR));
    expect(screen.queryByRole("region", { name: "Model picker" })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
