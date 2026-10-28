// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const linear = vi.hoisted(() => ({
  connected: false,
  pending: null as null | Promise<{ connected: boolean }>,
  save: vi.fn(),
  teams: [] as { id: string; name: string; key: string }[],
}));
const update = vi.hoisted(() => ({ snapshot: { phase: "idle", currentVersion: "1.0.300" } as Record<string, unknown> }));

vi.mock("../../lib/linear", () => ({
  linearConnected: () => linear.pending ?? Promise.resolve({ connected: linear.connected }),
  saveLinearToken: (...args: unknown[]) => linear.save(...args),
  disconnectLinear: async () => ({ connected: false }),
  listLinearTeams: async () => linear.teams,
  loadHiddenLinearTeamIds: () => ["t2"],
  saveHiddenLinearTeamIds: vi.fn(),
  notifyLinearChange: vi.fn(),
}));
vi.mock("../../lib/connection", () => ({ registry: { primary: () => ({ environmentId: "local" }) } }));
vi.mock("../../lib/githubTasks", () => ({ clearInboxCache: vi.fn() }));
vi.mock("../../lib/updateStore", () => ({
  updateStore: { install: vi.fn(), check: vi.fn() },
  useUpdateSnapshot: () => update.snapshot,
}));
const sounds = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("../../lib/sounds", () => ({ loadSoundsEnabled: () => true, saveSoundsEnabled: sounds.save, playCue: vi.fn() }));
vi.mock("../chunks", () => ({ releaseNotesChunk: { intent: {} } }));
vi.mock("../../lib/native", async (original) => ({
  ...(await original<typeof import("../../lib/native")>()),
  isWebMode: () => false,
  openUrl: vi.fn(),
}));
vi.mock("../../components/choice-select", async () => await import("../../components/choice-select-body"));

const { GeneralPage, updateActionLabel } = await import("./General");

function mockLocalStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
      clear: () => data.clear(),
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() {
        return data.size;
      },
    },
  });
}

beforeEach(() => {
  mockLocalStorage();
  linear.connected = false;
  linear.teams = [];
  linear.save.mockReset();
  update.snapshot = { phase: "idle", currentVersion: "1.0.300" };
});
afterEach(cleanup);

const page = () => render(<GeneralPage onOpenWhatsNew={() => {}} />);

describe("General", () => {
  it("lays its sections out in order", async () => {
    page();
    await act(async () => {});
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Transcript",
      "Composer",
      "Linear",
      "Extras",
      "About",
    ]);
  });

  it("saves a switch's setting", async () => {
    page();
    await act(async () => {});
    const cues = screen.getByRole("switch", { name: "Sounds" });
    expect(cues.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(cues);
    expect(sounds.save).toHaveBeenCalledWith(false);
    expect(cues.getAttribute("aria-checked")).toBe("false");
  });

  it("has no switches for the retired rail features", async () => {
    page();
    await act(async () => {});
    for (const name of ["Rail", "Notes", "Working agents"]) expect(screen.queryByText(name)).toBeNull();
  });

  it("connects Linear in a dialog: Enter checks the key, a refusal stays in the dialog", async () => {
    let refuse: (error: Error) => void = () => {};
    linear.save.mockReturnValue(new Promise((_, reject) => (refuse = reject)));
    page();
    await act(async () => {});
    // The row has one control and no field of its own.
    expect(screen.queryByLabelText("Linear API key")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connect…" }));
    const field = await screen.findByLabelText("Linear API key");
    expect(screen.getByRole("dialog", { name: "Connect Linear" })).toBeTruthy();
    fireEvent.change(field, { target: { value: "lin_api_x" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(linear.save).toHaveBeenCalledWith("local", "lin_api_x");
    expect(screen.getByRole("button", { name: /Connect$/ }).querySelector("[data-slot=spinner]")).toBeTruthy();
    await act(async () => refuse(new Error("That key was refused.")));
    expect(screen.getByText("That key was refused.").className).toContain("text-destructive");
    expect(screen.getByRole("dialog", { name: "Connect Linear" })).toBeTruthy();
  });

  it("closes the dialog once the key is taken, and the row's control becomes Disconnect", async () => {
    linear.save.mockResolvedValue(undefined);
    page();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Connect…" }));
    fireEvent.change(await screen.findByLabelText("Linear API key"), { target: { value: "lin_api_x" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(screen.queryByText(/Create a personal key/)).toBeNull();
  });

  it("lists the teams with a box each, hidden ones unchecked", async () => {
    linear.connected = true;
    linear.teams = [
      { id: "t1", name: "Core", key: "COR" },
      { id: "t2", name: "Web", key: "WEB" },
    ];
    page();
    await waitFor(() => screen.getByRole("region", { name: "Teams in the inbox" }));
    expect(screen.getByRole("checkbox", { name: "Core" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("checkbox", { name: "Web" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });

  it("names the release action for each updater phase", () => {
    const plain = { canApply: true, retry: false };
    expect(updateActionLabel("idle", plain)).toBe("Check for updates");
    expect(updateActionLabel("available", plain)).toBe("Update");
    expect(updateActionLabel("available", { canApply: false, retry: false })).toBe("Check for updates");
    expect(updateActionLabel("ready", plain)).toBe("Restart");
    expect(updateActionLabel("error", { canApply: true, retry: true })).toBe("Retry");
  });

  it("draws the release row with its version and one updater button in every phase", async () => {
    const phases: Record<string, unknown>[] = [
      { phase: "idle", currentVersion: "1.0.300", canApply: true },
      { phase: "checking", currentVersion: "1.0.300", canApply: true },
      { phase: "available", currentVersion: "1.0.300", availableVersion: "1.0.301", canApply: true },
      { phase: "downloading", currentVersion: "1.0.300", availableVersion: "1.0.301", percent: 10, canApply: true },
      { phase: "ready", currentVersion: "1.0.300", availableVersion: "1.0.301", canApply: true },
    ];
    for (const snapshot of phases) {
      update.snapshot = snapshot;
      page();
      await act(async () => {});
      const row = document.querySelector("[data-slot=page-row] [class*=font-mono]")?.closest("[data-slot=page-row]") as HTMLElement;
      expect(row.textContent).toContain("1.0.300");
      expect(row.querySelectorAll("button")).toHaveLength(1);
      cleanup();
    }
    update.snapshot = { phase: "ready", currentVersion: "1.0.300", availableVersion: "1.0.301", canApply: true };
    page();
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Restart" }).dataset.variant).toBe("default");
  });

  it("ends a failed update's line with a link to the installer", async () => {
    update.snapshot = { phase: "error", currentVersion: "1.0.300", error: "The signature did not match.", canApply: true };
    page();
    await act(async () => {});
    const native = await import("../../lib/native");
    const link = screen.getByRole("button", { name: "Download the installer" });
    expect(link.dataset.variant).toBe("link");
    expect(link.closest("[class*=text-destructive]")?.textContent).toContain("The signature did not match.");
    fireEvent.click(link);
    expect(native.openUrl).toHaveBeenCalled();
  });

  it("opens the bundled release notes, or a waiting update's from the feed", async () => {
    const open = vi.fn();
    render(<GeneralPage onOpenWhatsNew={open} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(open).toHaveBeenCalledWith(expect.any(String), expect.anything());
    expect(open.mock.calls[0][0]).not.toBe("1.0.301");
    cleanup();
    open.mockClear();
    update.snapshot = { phase: "available", currentVersion: "1.0.300", availableVersion: "1.0.301", notes: "Faster.", canApply: true };
    render(<GeneralPage onOpenWhatsNew={open} />);
    await act(async () => {});
    expect(screen.getByText("For 1.0.301")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(open).toHaveBeenCalledWith("1.0.301", "Faster.");
  });

  it("shows the download's progress", async () => {
    update.snapshot = { phase: "downloading", currentVersion: "1.0.300", availableVersion: "1.0.301", percent: 40, canApply: true };
    page();
    await act(async () => {});
    expect(screen.getByRole("progressbar", { name: "Download" }).getAttribute("aria-valuenow")).toBe("40");
  });

  it("holds the Linear row in its shape until the host says whether it is connected", async () => {
    let answer: (status: { connected: boolean }) => void = () => {};
    linear.pending = new Promise((resolve) => (answer = resolve));
    page();
    const section = screen.getByRole("region", { name: "Linear" });
    expect(section.querySelector("[data-slot=page-row-skeleton]")).toBeTruthy();
    expect(screen.queryByLabelText("Linear API key")).toBeNull();
    await act(async () => answer({ connected: true }));
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    linear.pending = null;
  });

  it("leaves Plans to Thread defaults", async () => {
    page();
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Plans" })).toBeNull();
  });
});
