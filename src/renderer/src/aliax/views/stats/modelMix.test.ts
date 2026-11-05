import { describe, expect, it } from "vitest";
import { modelMix, OTHER_KEY } from "./modelMix";

const day = (model: string, value: number, d = "2026-10-09") => ({ day: d, model, value });

describe("modelMix", () => {
  it("gives a model its provider's colour, never its rank's", () => {
    const { series } = modelMix({
      byModel: [
        { name: "gpt-6.1-sol", value: 900, turns: 1 },
        { name: "claude-opus-5-5", value: 500, turns: 1 },
      ],
      modelDaily: [day("gpt-6.1-sol", 900), day("claude-opus-5-5", 500)],
    });
    expect(series.map((s) => [s.key, s.color])).toEqual([
      ["gpt-6.1-sol", "var(--chart-2)"],
      ["claude-opus-5-5", "var(--chart-1)"],
    ]);
  });

  it("gives each provider two slots and folds the rest into Other, so the stack is the day's whole", () => {
    const names = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "gpt-6.1-sol", "gpt-6-sol", "o9"];
    const { series, rows } = modelMix({
      byModel: names.map((name, i) => ({ name, value: 100 - i, turns: 1 })),
      modelDaily: names.map((n) => day(n, 10)),
    });
    expect(series.map((s) => [s.key, s.color])).toEqual([
      ["claude-opus-5-5", "var(--chart-1)"],
      ["claude-sonnet-5-5", "var(--chart-3)"],
      ["gpt-6.1-sol", "var(--chart-2)"],
      ["gpt-6-sol", "var(--chart-4)"],
      [OTHER_KEY, "var(--muted-foreground)"],
    ]);
    expect(series.at(-1)!.name).toBe("Other");
    const row = rows[0];
    const total = series.reduce((sum, s) => sum + (row[s.key] as number), 0);
    expect(total).toBe(60);
    expect(row[OTHER_KEY]).toBe(20);
  });

  it("draws no Other when every model has a slot", () => {
    const { series } = modelMix({ byModel: [{ name: "claude-opus-5-5", value: 1, turns: 1 }], modelDaily: [day("claude-opus-5-5", 1)] });
    expect(series.map((s) => s.key)).toEqual(["claude-opus-5-5"]);
  });
});
