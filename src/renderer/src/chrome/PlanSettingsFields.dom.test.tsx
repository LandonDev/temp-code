// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PLAN_SETTINGS } from "@shared/plans";

const plans = vi.hoisted(() => ({
  scope: null as null | { settings: unknown; overridden: boolean },
  failure: null as null | { error: string; retry: () => void },
}));
vi.mock("../lib/connection", () => ({ registry: { primary: () => ({ environmentId: "local" }) } }));
vi.mock("../lib/tcserver/plans", () => ({
  usePlanSettings: () => plans.scope,
  usePlanSettingsError: () => plans.failure,
  savePlanSettings: async () => {},
}));
vi.mock("../lib/models", () => ({ allModels: () => [], findModel: () => ({ name: "Opus 5.5" }), nativeModelId: (m: { id: string }) => m.id }));
vi.mock("../components/choice-select", async () => await import("../components/choice-select-body"));

const { PlanSettingsEditor, PlanSettingsSummary } = await import("./PlanSettingsFields");

afterEach(cleanup);

describe("Plans", () => {
  it("holds its rows in their shape until the set loads, with no Reset", () => {
    plans.scope = null;
    render(<PlanSettingsEditor />);
    expect(screen.getByRole("region", { name: "Plans" }).querySelectorAll("[data-slot=page-row-skeleton]").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  });

  it("says why the set did not load, with Retry in the heading, and no rows forever", () => {
    plans.scope = null;
    const retry = vi.fn();
    plans.failure = { error: "not connected", retry };
    render(<PlanSettingsEditor />);
    const section = screen.getByRole("region", { name: "Plans" });
    expect(section.querySelectorAll("[data-slot=page-row-skeleton]")).toHaveLength(0);
    expect(screen.getByText("not connected").className).toContain("text-destructive");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalled();
    plans.failure = null;
  });

  it("draws the loaded set's rows", () => {
    plans.scope = { settings: DEFAULT_PLAN_SETTINGS, overridden: false };
    render(<PlanSettingsEditor />);
    expect(screen.getByRole("switch", { name: "Start the build on its own" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Build model" })).toBeTruthy();
  });

  it("summarises a set as separate facts, never a dotted line", () => {
    render(
      <PlanSettingsSummary
        settings={{ ...DEFAULT_PLAN_SETTINGS, autoImplement: true, implementModel: "opus", implementContext: "1m" }}
        extra="global"
      />,
    );
    const parts = [...document.querySelectorAll("span > span")].map((el) => el.textContent);
    expect(parts).toEqual(["Auto-start", "Opus 5.5", "1M", "global"]);
    expect(document.body.textContent).not.toContain("·");
  });
});
