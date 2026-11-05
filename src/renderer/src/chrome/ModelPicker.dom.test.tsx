// @vitest-environment jsdom
/**
 * The model menu: the button reads the model and the effort; the foot
 * holds the current model's settings, with Speed only for the tiers the
 * serving CLI lists (never a claim about the account). How full the
 * context window is lives in the composer's meter, never here.
 */
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { findModel, mergeModelSettings, resetHarnessModelOverlays, saveModelPickerTab, setHarnessModels } from "../lib/models";
import { agentModelsFor } from "../lib/tcserver/catalog";
import type { ModelInfo, ProviderInfo } from "../lib/tcserver/types";
import { ModelPicker } from "./ModelPicker";
import type { HarnessId } from "../lib/session";
import { menuChunk, selectChunk } from "../surfaces/chunks";
import { accountsStore } from "../stores/accounts";
import { emptyAccounts, type AccountsSnapshot } from "@server/shared/accounts";
import type { Link } from "../lib/connection/types";
import type { ServerPush } from "@server/shared/contract";
import { warmMenus } from "./menuRows";

// The menus here are drawn by their parts (components/ui/lazy-menus.tsx): warm their body first.
beforeAll(async () => {
  await menuChunk.load();
  warmMenus();
});

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

function seed(provider: "claude" | "codex" | "muse", models: ModelInfo[]) {
  const info: ProviderInfo = { id: provider, label: provider, defaultModel: models[0].id, models };
  setHarnessModels(provider, agentModelsFor(info), models[0].id);
}

function picker(harness: HarnessId, model: string, values: Record<string, string> = {}) {
  const onChange = vi.fn();
  render(<ModelPicker harness={harness} model={model} onChange={() => {}} settings={{ values, onChange }} />);
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

// The real select at mount; components/lazy-select.dom.test.tsx proves the cold trigger.
beforeAll(async () => {
  await selectChunk.load();
});

describe("ModelPicker", () => {
  it("Muse Code lists its probed models under its own name, the effort on the ladder the probe gave", async () => {
    seed("muse", [
      { id: "muse-wonder-1.0", label: "Muse Wonder 1.0", reasoning: EFFORTS, defaultReasoning: "max", context: 1_007_997 },
      { id: "muse-wonder-full-1.0", label: "Muse Wonder Full 1.0", reasoning: EFFORTS, defaultReasoning: "max", context: 1_007_997 },
    ]);
    picker("muse", "muse:muse-wonder-1.0", { effort: "max" });
    const button = screen.getByRole("button", { name: /^Muse Code Muse Wonder 1\.0/ });
    expect(button.textContent).toContain("Max");
    const dialog = await open(/^Muse Code Muse Wonder 1\.0/);
    const effort = within(dialog).getByRole("combobox", { name: "Effort" });
    await act(async () => fireEvent.click(effort));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Low", "Medium", "High", "Extra high", "Max"]);
  });

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

  it("Claude's Context row is its window setting alone, with no percent", async () => {
    seed("claude", [{ id: "claude-opus-5-5", label: "Opus 5.5", reasoning: EFFORTS, context: 1_000_000 }]);
    picker("claude", "claude:claude-opus-5-5");
    const menu = await open(/Opus 5\.5/);
    expect(within(menu).getAllByText("Context")).toHaveLength(1);
    expect(within(menu).getByRole("combobox", { name: "Context" })).toBeTruthy();
    expect(menu.textContent).not.toMatch(/\d+%/);
  });

  it("Codex has no context setting and so no Context row", async () => {
    seed("codex", [{ id: "gpt-a", label: "A", reasoning: ["low", "high"], speedTiers: ["priority"] }]);
    picker("codex", "codex:gpt-a");
    const menu = await open(/^Codex A/);
    const rows = menu.querySelector("[data-model-settings-rows]")!;
    expect([...rows.children].map((row) => row.firstElementChild?.textContent)).toEqual(["Effort", "Speed"]);
    expect(menu.textContent).not.toMatch(/\d+%/);
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

/** A host whose accounts snapshot the picker reads: with a Meta key on file, or none. */
class FakeLink implements Link {
  environmentId = "local";
  profile = "local" as const;
  connected = true;
  constructor(private readonly snapshot: AccountsSnapshot) {}
  request<T>(method: string): Promise<T> {
    if (method === "accounts.list") return Promise.resolve(this.snapshot as T);
    return Promise.reject(new Error(`unexpected ${method}`));
  }
  onPush(_listener: (push: ServerPush) => void): () => void {
    return () => {};
  }
  onOpen(): () => void {
    return () => {};
  }
  onClose(): () => void {
    return () => {};
  }
}
async function hostWithMetaKey(keyed = true) {
  const snapshot = emptyAccounts();
  if (keyed) snapshot.providers.meta = { pinned: null, owner: "temp-code", profiles: [{ name: "Meta key …LJY", createdAt: 1, active: false, static: true, kind: "key" }], reports: [] };
  accountsStore.attach(new FakeLink(snapshot));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("ModelPicker: Meta's models", () => {
  const META_LADDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as ModelInfo["reasoning"];
  const meta = (efforts: ModelInfo["reasoning"]): ModelInfo[] => [
    { id: "muse-wonder-1.0", label: "Muse Wonder 1.0", reasoning: efforts, defaultReasoning: "high", context: 1_048_576, vendor: "meta" },
    { id: "muse-spark-1.3", label: "Muse Spark 1.3", reasoning: efforts, defaultReasoning: "medium", context: 1_048_576, vendor: "meta" },
  ];
  beforeEach(async () => {
    seed("claude", [{ id: "claude-opus-5-5", label: "Opus 5.5", reasoning: EFFORTS, defaultReasoning: "medium", context: 1_000_000 }, ...meta(EFFORTS)]);
    seed("codex", [...meta(META_LADDER), { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", reasoning: EFFORTS, defaultReasoning: "low" }]);
    await hostWithMetaKey();
  });
  afterEach(() => accountsStore.reset());

  it("without a Meta key on the host the Claude and Codex tabs and the search leave Meta's rows out", async () => {
    accountsStore.reset();
    await hostWithMetaKey(false);
    saveModelPickerTab("claude");
    picker("claude", "claude:claude-opus-5-5");
    const menu = await open(/Opus 5\.5/);
    expect(groupIn(menu)).toBeNull();
    expect(within(menu).getAllByRole("option").map((o) => o.querySelector("span")?.textContent)).toEqual(["Opus 5.5"]);
    await act(async () => {
      fireEvent.change(within(menu).getByRole("textbox", { name: "Search models" }), { target: { value: "muse" } });
    });
    // Only the Muse harness's own rows answer a search: nothing under Claude or Codex.
    expect(within(menu).queryAllByRole("option").every((o) => !o.querySelector("svg path")?.getAttribute("d")?.startsWith("M6.915"))).toBe(true);
  });

  const groupIn = (menu: HTMLElement) => menu.querySelector<HTMLElement>("[data-vendor-group=meta]");
  const effortOptions = async (menu: HTMLElement) => {
    await act(async () => {
      fireEvent.click(within(menu).getByRole("combobox", { name: "Effort" }));
    });
    return screen
      .getAllByRole("option")
      .filter((o) => !o.closest("[aria-label=Models]"))
      .map((o) => o.textContent);
  };

  it("lists Meta's rows under a Meta heading after the harness's own, in the claude and codex tabs", async () => {
    for (const [harness, own, button] of [
      ["claude", "Opus 5.5", /Opus 5\.5/],
      ["codex", "GPT-6.1 Sol", /GPT-6\.1 Sol/],
    ] as const) {
      saveModelPickerTab(harness);
      picker(harness, harness === "claude" ? "claude:claude-opus-5-5" : "codex:gpt-6.1-sol");
      const menu = await open(button);
      const group = groupIn(menu)!;
      expect(group).not.toBeNull();
      expect(group.getAttribute("role")).toBe("group");
      expect(group.getAttribute("aria-labelledby") && menu.querySelector(`#${CSS.escape(group.getAttribute("aria-labelledby")!)}`)?.textContent).toBe("Meta");
      expect(within(group).getAllByRole("option").map((o) => o.querySelector("span")?.textContent)).toEqual(["Muse Wonder 1.0", "Muse Spark 1.3"]);
      // The harness's own rows come first, outside the group; Meta's rows lead with the mark.
      const names = within(menu).getAllByRole("option").map((o) => o.querySelector("span")?.textContent);
      expect(names[0]).toBe(own);
      expect(within(group).getAllByRole("option").every((o) => o.querySelector("svg path")?.getAttribute("d")?.startsWith("M6.915"))).toBe(true);
      cleanup();
    }
  });

  it("picking Wonder lands on High and offers no context; Minimal only where the ladder has it", async () => {
    const wonder = findModel("claude:muse-wonder-1.0")!;
    // Fresh, and from a codex thread at minimal: Claude Code's Wonder starts at High.
    expect(mergeModelSettings(wonder, {})).toEqual({ effort: "high" });
    expect(mergeModelSettings(wonder, { effort: "minimal" })).toEqual({ effort: "high" });

    saveModelPickerTab("claude");
    const onPick = vi.fn();
    render(<ModelPicker harness="claude" model="claude:claude-opus-5-5" onChange={onPick} />);
    const list = await open(/Opus 5\.5/);
    await act(async () => {
      fireEvent.click(within(list).getByRole("option", { name: /Muse Wonder 1\.0/ }));
    });
    expect(onPick).toHaveBeenCalledWith("claude", "claude:muse-wonder-1.0");
    cleanup();

    picker("claude", "claude:muse-wonder-1.0", mergeModelSettings(wonder, {}));
    let menu = await open(/Muse Wonder 1\.0/);
    expect(screen.getByRole("button", { name: /Muse Wonder 1\.0 High/ })).toBeTruthy();
    expect(within(menu).queryByRole("combobox", { name: "Context" })).toBeNull();
    expect(await effortOptions(menu)).toEqual(["Low", "Medium", "High", "Extra high", "Max"]);
    cleanup();

    picker("codex", "codex:muse-wonder-1.0", { effort: "high" });
    menu = await open(/Muse Wonder 1\.0/);
    expect(within(menu).queryByRole("combobox", { name: "Context" })).toBeNull();
    expect(await effortOptions(menu)).toEqual(["Minimal", "Low", "Medium", "High", "Extra high", "Max"]);
  });

  it("the Codex tab reads as loading until its catalog lands, not as Meta's built-in rows", async () => {
    resetHarnessModelOverlays();
    saveModelPickerTab("codex");
    picker("claude", "claude:claude-opus-5");
    const menu = await open(/Opus 5/);
    expect(within(menu).queryAllByRole("option")).toHaveLength(0);
    expect(menu.textContent).toContain("Loading Codex models…");
  });

  it("search and favorites list Meta's rows with the mark and no heading", async () => {
    picker("claude", "claude:claude-opus-5-5");
    const menu = await open(/Opus 5\.5/);
    await act(async () => {
      fireEvent.change(within(menu).getByRole("textbox", { name: "Search models" }), { target: { value: "muse" } });
    });
    expect(groupIn(menu)).toBeNull();
    // Meta's four rows under claude and codex, plus Muse Code's own three static rows.
    expect(within(menu).getAllByRole("option")).toHaveLength(7);
  });
});
