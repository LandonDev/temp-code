// @vitest-environment jsdom
/**
 * The model menu: the button reads the model and the effort; the foot
 * holds the current model's settings, with Speed only for the tiers the
 * serving CLI lists (never a claim about the account) and the context
 * percent only when there is a reading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { resetHarnessModelOverlays, setHarnessModels } from "../lib/models";
import { agentModelsFor } from "../lib/tcserver/catalog";
import type { ModelInfo, ProviderInfo } from "../lib/tcserver/types";
import type { ContextUsage } from "../lib/contextUsage";
import { ModelPicker } from "./ModelPicker";
import type { HarnessId } from "../lib/session";

vi.mock("../lib/harness/availability", () => ({
  harnessUnavailableHint: () => "Not installed",
  hasProbedHarnessAvailability: () => true,
  isHarnessAvailable: () => true,
  probeHarnessAvailability: () => Promise.resolve(),
  subscribeHarnessAvailability: () => () => {},
  getHarnessAvailabilitySnapshot: () => 0,
}));
vi.mock("../lib/harness/registry", () => ({ refreshHarnessCatalogs: () => Promise.resolve() }));
vi.mock("../lib/connection", () => ({ registry: { primaryEnvironmentId: "local" } }));

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as ModelInfo["reasoning"];

function seed(provider: "claude" | "codex", models: ModelInfo[]) {
  const info: ProviderInfo = { id: provider, label: provider, defaultModel: models[0].id, models };
  setHarnessModels(provider, agentModelsFor(info), models[0].id);
}

function picker(harness: HarnessId, model: string, values: Record<string, string> = {}, context?: ContextUsage) {
  const onChange = vi.fn();
  render(
    <ModelPicker harness={harness} model={model} onChange={() => {}} settings={{ values, onChange, context }} />,
  );
  return onChange;
}

async function open(name: RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
  return screen.getByRole("dialog", { name: "Model picker" });
}

beforeEach(() => {
  localStorage.clear();
  resetHarnessModelOverlays();
});
afterEach(cleanup);

describe("ModelPicker", () => {
  it("the button reads the model and the effort", () => {
    seed("claude", [{ id: "claude-opus-5-5", label: "Opus 5.5", reasoning: EFFORTS, defaultReasoning: "medium", context: 1_000_000 }]);
    picker("claude", "claude:claude-opus-5-5", { effort: "high" });
    const button = screen.getByRole("button", { name: /Opus 5\.5/ });
    expect(button.textContent).toContain("Opus 5.5");
    expect(button.textContent).toContain("High");
  });

  it("Claude without tiers has no Speed row; with fast, Standard and Fast", async () => {
    seed("claude", [
      { id: "claude-opus-5-5", label: "Opus 5.5", reasoning: EFFORTS, context: 1_000_000 },
      { id: "claude-fable-5-1", label: "Fable 5.1", reasoning: EFFORTS, context: 1_000_000, speedTiers: ["fast"] },
    ]);
    picker("claude", "claude:claude-opus-5-5");
    let menu = await open(/Opus 5\.5/);
    expect(within(menu).queryByRole("combobox", { name: "Speed" })).toBeNull();
    expect(within(menu).getByRole("combobox", { name: "Effort" })).toBeTruthy();
    cleanup();
    picker("claude", "claude:claude-fable-5-1");
    menu = await open(/Fable 5\.1/);
    const speed = within(menu).getByRole("combobox", { name: "Speed" });
    expect(speed.textContent).toContain("Standard");
    await act(async () => fireEvent.click(speed));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(expect.arrayContaining(["Standard", "Fast"]));
    expect(screen.queryByRole("option", { name: "Ultrafast" })).toBeNull();
  });

  it("Codex: priority is Fast, priority and ultrafast are both, unprobed none", async () => {
    seed("codex", [
      { id: "gpt-a", label: "A", reasoning: ["low", "high"], speedTiers: ["priority"] },
      { id: "gpt-b", label: "B", reasoning: ["low", "high"], speedTiers: ["priority", "ultrafast"] },
      { id: "gpt-c", label: "C", reasoning: ["low", "high"] },
    ]);
    const options = async (name: RegExp) => {
      const menu = await open(name);
      const speed = within(menu).queryByRole("combobox", { name: "Speed" });
      if (!speed) return null;
      await act(async () => fireEvent.click(speed));
      return screen.getAllByRole("option").map((o) => o.textContent);
    };
    picker("codex", "codex:gpt-a");
    expect(await options(/^Codex A/)).toEqual(["Standard", "Fast"]);
    cleanup();
    picker("codex", "codex:gpt-b");
    expect(await options(/^Codex B/)).toEqual(["Standard", "Fast", "Ultrafast"]);
    cleanup();
    picker("codex", "codex:gpt-c");
    expect(await options(/^Codex C/)).toBeNull();
  });

  it("picking Ultrafast turns Fast off", async () => {
    seed("codex", [{ id: "gpt-b", label: "B", reasoning: [], speedTiers: ["priority", "ultrafast"] }]);
    const onChange = picker("codex", "codex:gpt-b", { fast: "true" });
    const menu = await open(/^Codex B/);
    await act(async () => fireEvent.click(within(menu).getByRole("combobox", { name: "Speed" })));
    const option = screen.getByRole("option", { name: "Ultrafast" });
    await act(async () => {
      fireEvent.pointerDown(option, { pointerType: "mouse" });
      fireEvent.mouseDown(option);
      fireEvent.pointerUp(option, { pointerType: "mouse" });
      fireEvent.mouseUp(option);
      fireEvent.click(option);
    });
    expect(onChange).toHaveBeenLastCalledWith({ fast: "false", ultrafast: "true" });
  });

  it("Context shows its percent only with a reading", async () => {
    seed("claude", [{ id: "claude-opus-5-5", label: "Opus 5.5", reasoning: EFFORTS, context: 1_000_000 }]);
    picker("claude", "claude:claude-opus-5-5", {}, { used: 84_000, window: 200_000 });
    let menu = await open(/Opus 5\.5/);
    expect(menu.textContent).toContain("42%");
    cleanup();
    picker("claude", "claude:claude-opus-5-5");
    menu = await open(/Opus 5\.5/);
    expect(menu.textContent).not.toMatch(/\d+%/);
  });

  it("Codex has no context setting, so a reading gets a read-only Context row after Effort", async () => {
    seed("codex", [{ id: "gpt-a", label: "A", reasoning: ["low", "high"], speedTiers: ["priority"] }]);
    picker("codex", "codex:gpt-a", {}, { used: 28_500, window: 475_000 });
    let menu = await open(/^Codex A/);
    const rows = menu.querySelector("[data-model-settings-rows]")!;
    const labels = [...rows.children].map((row) => row.firstElementChild?.textContent);
    expect(labels).toEqual(["Effort", "Context", "Speed"]);
    expect(rows.children[1].textContent).toBe("Context6%475K");
    expect(within(rows.children[1] as HTMLElement).queryByRole("combobox")).toBeNull();
    cleanup();
    picker("codex", "codex:gpt-a");
    menu = await open(/^Codex A/);
    expect(menu.textContent).not.toContain("Context");
  });

  it("Claude's Context row keeps its select, with the percent beside it", async () => {
    seed("claude", [{ id: "claude-opus-5-5", label: "Opus 5.5", reasoning: EFFORTS, context: 1_000_000 }]);
    picker("claude", "claude:claude-opus-5-5", {}, { used: 84_000, window: 200_000 });
    const menu = await open(/Opus 5\.5/);
    expect(within(menu).getAllByText("Context")).toHaveLength(1);
    expect(within(menu).getByRole("combobox", { name: "Context" })).toBeTruthy();
  });

  it("Escape returns focus to the model button; a pick hands it to the field", async () => {
    seed("claude", [
      { id: "claude-opus-5-5", label: "Opus 5.5", reasoning: EFFORTS, context: 1_000_000 },
      { id: "claude-fable-5-1", label: "Fable 5.1", reasoning: EFFORTS, context: 1_000_000 },
    ]);
    const onClose = vi.fn();
    render(<ModelPicker harness="claude" model="claude:claude-opus-5-5" onChange={() => {}} onClose={onClose} />);
    const trigger = screen.getByRole("button", { name: /Opus 5\.5/ });
    let menu = await open(/Opus 5\.5/);
    await act(async () => {
      fireEvent.keyDown(within(menu).getByRole("textbox"), { key: "Escape" });
    });
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    menu = await open(/Opus 5\.5/);
    await act(async () => {
      fireEvent.change(within(menu).getByRole("textbox"), { target: { value: "Fable" } });
    });
    await act(async () => {
      fireEvent.click(within(menu).getByRole("option", { name: /Fable 5\.1/ }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says nothing it cannot know", async () => {
    seed("codex", [{ id: "gpt-a", label: "A", reasoning: ["low"], speedTiers: ["priority"] }]);
    picker("codex", "codex:gpt-a");
    const menu = await open(/^Codex A/);
    expect(menu.textContent).not.toMatch(/priority processing|fastest service tier|not on this account/i);
  });
});
