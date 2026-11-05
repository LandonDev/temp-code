// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../components/ui/tooltip";
import { awayStore, resetAwayForTest } from "../lib/away";
import { registry } from "../lib/connection/registry";
import { clockTime } from "../lib/duration";
import { AwayRow, awayTooltip } from "./AwayRow";
import { RailFoot } from "./ProjectRail";

const toast = vi.hoisted(() => ({ error: vi.fn(), call: vi.fn() }));
vi.mock("../components/ui/toaster", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../components/ui/toaster")>()),
  loadToast: () => Promise.resolve(Object.assign(toast.call, { error: toast.error })),
}));
vi.mock("./UsageMeter", () => ({ UsageMeter: () => null }));
vi.mock("./UpdateRow", () => ({ UpdateRow: () => null, useUpdateRowState: () => null }));
vi.mock("./SignInRow", () => ({ SignInRow: () => null, useSignInTarget: () => null }));

/** A primary link that answers `away.set` as `answer` says. */
function primaryLink(answer: (enabled: boolean) => Promise<unknown>) {
  const request = vi.fn((method: string, params: { enabled: boolean }) =>
    method === "away.set" ? answer(params.enabled) : Promise.reject(new Error("no")),
  );
  vi.spyOn(registry, "linkOf").mockReturnValue({ request } as never);
  return request;
}

const host = (enabled: boolean, at = 1_000) => ({
  [registry.primaryEnvironmentId]: { state: { enabled, at, by: "env_mac" }, decided: { since: at, threads: [] } },
});

const switchRow = () => screen.getByRole("switch", { name: "Away from computer" });
const track = () => document.querySelector<HTMLElement>("[data-slot=away-track]")!;
const glyph = () => switchRow().querySelector<HTMLElement>("svg")!.parentElement!;

beforeEach(() => {
  resetAwayForTest();
  vi.spyOn(registry, "onLink").mockReturnValue(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  toast.error.mockReset();
  resetAwayForTest();
});

describe("AwayRow", () => {
  it("is one native switch named Away from computer, off until the host says on", () => {
    render(<AwayRow />);
    const row = switchRow();
    // A native button: Space and Enter press it as a click does.
    expect(row.tagName).toBe("BUTTON");
    expect(row.getAttribute("type")).toBe("button");
    expect(row.getAttribute("aria-checked")).toBe("false");
    expect(row.textContent).toBe("Away from computer");
    act(() => awayStore.setState({ hosts: host(true) }));
    expect(switchRow().getAttribute("aria-checked")).toBe("true");
  });

  it("takes the warning tone on the track and the moon only while on", () => {
    render(<AwayRow />);
    expect(track().dataset.on).toBe("false");
    expect(track().className).toContain("data-[on=true]:bg-warning");
    expect(glyph().className).not.toContain("text-warning");
    act(() => awayStore.setState({ hosts: host(true) }));
    expect(track().dataset.on).toBe("true");
    expect(glyph().className).toContain("text-warning");
    expect(switchRow().closest("[data-rail-row]")!.className).toContain("text-foreground");
  });

  it("flips at once on a press, Space or Enter, and stays when the host agrees", async () => {
    const request = primaryLink(async (enabled) => ({ state: { enabled, at: 2_000, by: "env_mac" } }));
    render(<AwayRow />);
    fireEvent.keyDown(switchRow(), { key: " " });
    fireEvent.click(switchRow());
    expect(switchRow().getAttribute("aria-checked")).toBe("true");
    expect(request).toHaveBeenCalledWith("away.set", { enabled: true });
    await act(async () => {});
    expect(switchRow().getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(switchRow(), { key: "Enter" });
    fireEvent.click(switchRow());
    expect(switchRow().getAttribute("aria-checked")).toBe("false");
    expect(request).toHaveBeenLastCalledWith("away.set", { enabled: false });
  });

  it("rolls back with a toast when the host refuses", async () => {
    primaryLink(() => Promise.reject(new Error("forbidden: needs approve")));
    render(<AwayRow />);
    fireEvent.click(switchRow());
    expect(switchRow().getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't turn Away on"));
    expect(switchRow().getAttribute("aria-checked")).toBe("false");
    act(() => awayStore.setState({ hosts: host(true) }));
    fireEvent.click(switchRow());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't turn Away off"));
    expect(switchRow().getAttribute("aria-checked")).toBe("true");
  });

  it("says what it does while off and since when while on, in a tooltip, never a title", () => {
    expect(awayTooltip(false, 0)).toBe("Threads decide without asking you");
    const at = new Date(2026, 10, 5, 14, 14).getTime();
    expect(awayTooltip(true, at)).toBe(`Away since ${clockTime(at)}`);
    render(
      <TooltipProvider>
        <AwayRow />
      </TooltipProvider>,
    );
    expect(switchRow().getAttribute("title")).toBeNull();
  });

  it("sits right above Settings in the foot, the collapsed column's foot included", () => {
    render(<RailFoot onAddWorkspace={() => {}} />);
    const rows = [...document.querySelectorAll("[data-rail-row] button")].map((b) => b.textContent);
    expect(rows.slice(-2)).toEqual(["Away from computer", "Settings"]);
  });

  it("draws its track from switch-track.ts, with no Base UI switch", () => {
    const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    for (const source of [read("./AwayRow.tsx"), read("../components/ui/switch-track.ts"), read("../components/ui/switch.tsx")]) {
      expect(source).not.toMatch(/@base-ui\/react\/switch/);
    }
    expect(read("./AwayRow.tsx")).toContain("components/ui/switch-track");
    expect(read("../components/ui/switch.tsx")).toContain("./switch-track");
  });
});
