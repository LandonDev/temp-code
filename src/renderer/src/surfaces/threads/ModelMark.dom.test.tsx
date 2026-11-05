// @vitest-environment jsdom
/**
 * The model mark (UI-23): the provider's logo, the short model name and,
 * with `effort`, the effort in the composer's words after it; the tooltip
 * keeps the whole model, effort and context.
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { tooltipChunk, warmTooltips } from "../../components/ui/tooltip";
import { ModelMark, contextWindowWord, modelContextWord } from "./ModelMark";

const META_PATH = /^M6\.915 4\.03/;
const tipText = () => document.querySelector('[data-slot="tooltip-content"]')?.textContent ?? null;
const opus = { provider: "claude", model: "claude-opus-5-5", reasoning: "high", context1m: false } as const;

beforeAll(async () => {
  await act(async () => {
    await tooltipChunk.load();
    warmTooltips();
  });
});

afterEach(cleanup);

describe("ModelMark", () => {
  it("draws the effort word after the name", () => {
    const { container } = render(<ModelMark meta={opus} effort />);
    const mark = container.querySelector("[data-model]")!;
    const parts = [...mark.querySelectorAll("[data-model-name], [data-model-effort]")].map((el) => el.textContent);
    expect(parts).toEqual(["Opus 5.5", "High"]);
    expect(mark.textContent).toBe("Opus 5.5High");
  });

  it("reads xhigh as Extra high and a rung the map lacks capitalised", () => {
    const xhigh = render(<ModelMark meta={{ ...opus, reasoning: "xhigh" }} effort />);
    expect(xhigh.container.querySelector("[data-model-effort]")?.textContent).toBe("Extra high");
    xhigh.unmount();
    const ultra = render(<ModelMark meta={{ provider: "codex", model: "gpt-6.1-sol", reasoning: "ultra" }} effort />);
    expect(ultra.container.querySelector("[data-model-effort]")?.textContent).toBe("Ultra");
  });

  it("draws no effort without the prop or without a reasoning", () => {
    const off = render(<ModelMark meta={opus} />);
    expect(off.container.querySelector("[data-model-effort]")).toBeNull();
    off.unmount();
    const cursor = render(<ModelMark meta={{ provider: "cursor", model: "composer-2.5", reasoning: undefined }} effort />);
    expect(cursor.container.querySelector("[data-model]")).not.toBeNull();
    expect(cursor.container.querySelector("[data-model-effort]")).toBeNull();
  });

  it("keeps the whole model, effort and context in the tooltip, after the lead", async () => {
    const { container } = render(<ModelMark meta={{ ...opus, reasoning: "xhigh", context1m: true }} lead="Reviewer" effort />);
    const mark = container.querySelector("[data-model]")!;
    fireEvent.pointerEnter(mark);
    fireEvent.mouseEnter(mark);
    fireEvent.focus(mark);
    await waitFor(() => expect(tipText()).toBe("Reviewer, Claude Opus 5.5, extra high effort, 1M context"), { timeout: 2000 });
  });

  it("draws Meta's mark for a vendor row", () => {
    const { container } = render(<ModelMark meta={{ provider: "codex", model: "muse-wonder-1.0", reasoning: "high" }} effort />);
    expect(container.querySelector("[data-model] svg path")?.getAttribute("d")).toMatch(META_PATH);
  });

  it("draws Meta's mark for a Muse Code row and names Muse Code in its tooltip", async () => {
    const { container } = render(<ModelMark meta={{ provider: "muse", model: "muse-spark-1.3", reasoning: "medium" }} effort />);
    const mark = container.querySelector("[data-model]")!;
    expect(mark.querySelector("svg path")?.getAttribute("d")).toMatch(META_PATH);
    expect(mark.querySelector("[data-model-name]")?.textContent).toBe("Muse Spark 1.3");
    fireEvent.pointerEnter(mark);
    fireEvent.mouseEnter(mark);
    fireEvent.focus(mark);
    await waitFor(() => expect(tipText()).toBe("Muse Spark 1.3 on Muse Code, medium effort"), { timeout: 2000 });
  });

  it("truncates the name, never the effort, and leaves the title to give way first", () => {
    const { container } = render(<ModelMark meta={opus} effort nameClassName="n-hide" effortClassName="e-hide" />);
    const mark = container.querySelector("[data-model]")!;
    expect(mark.className).not.toContain("shrink-[1000]");
    expect(mark.className).toContain("min-w-0");
    const name = mark.querySelector("[data-model-name]")!;
    const effort = mark.querySelector("[data-model-effort]")!;
    expect(name.className).toContain("truncate");
    expect(name.className).toContain("n-hide");
    expect(effort.className).toContain("shrink-0");
    expect(effort.className).toContain("e-hide");
  });
});

describe("the context word", () => {
  it("contextWindowWord says a window in the composer's words", () => {
    expect(contextWindowWord(1_000_000)).toBe("1M");
    expect(contextWindowWord(1_048_576)).toBe("1M");
    expect(contextWindowWord(200_000)).toBe("200k");
    expect(contextWindowWord(272_000)).toBe("272k");
  });

  it("modelContextWord reads a Claude thread's 1M flag, else the catalog's window, else the harness's report", () => {
    expect(modelContextWord({ provider: "claude", model: "claude-opus-5-5", context1m: true })).toBe("1M");
    expect(modelContextWord({ provider: "claude", model: "claude-opus-5-5" })).toBe("200k");
    // A vendor row's window is native: never the 1M flag's choice.
    expect(modelContextWord({ provider: "claude", model: "muse-spark-1.3", context1m: false })).toBe("1M");
    expect(modelContextWord({ provider: "grok", model: "grok-4.6" })).toBe("500k");
    expect(modelContextWord({ provider: "codex", model: "gpt-6.1-sol", context: { tokens: 10, window: 272_000 } })).toBe("272k");
    expect(modelContextWord({ provider: "codex", model: "gpt-6.1-sol" })).toBe("");
    expect(modelContextWord({})).toBe("");
  });
});
