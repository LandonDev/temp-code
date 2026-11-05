// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChoiceSelect } from "./choice-select";
import { resetSelects } from "./lazy-select";

/** A select chunk this file holds back: cold until a test lets it land. */
const chunk = vi.hoisted(() => ({ module: null as object | null, release: null as null | (() => void) }));
vi.mock("../surfaces/chunks", () => {
  const load = () =>
    new Promise<object>((resolve) => {
      chunk.release = async () => {
        chunk.module = await import("./select-body");
        resolve(chunk.module);
      };
    });
  return { selectChunk: { load, preload: () => void load(), loaded: () => chunk.module, intent: {} } };
});

const OPTIONS = [
  { value: "low", label: "Low" },
  { value: "high", label: "High" },
];

beforeEach(() => {
  chunk.module = null;
  chunk.release = null;
  resetSelects();
});
afterEach(cleanup);

describe("ChoiceSelect before the select chunk lands", () => {
  it("is its own trigger at the caller's size and width, showing the chosen label", () => {
    render(<ChoiceSelect label="Effort" value="high" options={OPTIONS} onChange={() => {}} size="sm" className="w-44" />);
    const trigger = screen.getByRole("combobox", { name: "Effort" });
    expect(trigger.dataset.slot).toBe("select-trigger");
    expect(trigger.dataset.size).toBe("sm");
    expect(trigger.className).toContain("w-44");
    expect(trigger.textContent).toBe("High");
    expect(document.querySelector("[data-slot=skeleton]")).toBeNull();
  });

  it("asks for the chunk as it mounts and swaps to the real select in the same box", async () => {
    render(<ChoiceSelect label="Effort" value="low" options={OPTIONS} onChange={() => {}} size="sm" className="w-44" />);
    expect(chunk.release).not.toBeNull();
    const cold = screen.getByRole("combobox", { name: "Effort" });
    await act(async () => chunk.release?.());
    const warm = screen.getByRole("combobox", { name: "Effort" });
    expect(warm).not.toBe(cold);
    expect(warm.dataset.size).toBe("sm");
    expect(warm.className).toContain("w-44");
    expect(warm.textContent).toContain("Low");
  });
});
