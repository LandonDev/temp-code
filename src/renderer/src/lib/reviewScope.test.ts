import { describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "@server/shared/rules";
import { DEFAULT_REVIEW_SETTINGS } from "@server/shared/review";
import { parseReviewScope, reviewSummary, reviewerModelOptions } from "./reviewScope";

describe("review scope", () => {
  it("reads the server's answer and falls back to the defaults", () => {
    const on = { ...DEFAULT_REVIEW_SETTINGS, beforeMerge: true };
    expect(parseReviewScope({ override: null, global: on, settings: on, source: "global" })).toEqual({
      override: null,
      global: on,
      settings: on,
      source: "global",
    });
    expect(parseReviewScope(undefined)).toEqual({ override: null, global: null, settings: DEFAULT_REVIEW_SETTINGS, source: "default" });
    expect(parseReviewScope({ override: { beforeMerge: "yes" }, source: "project" }).override).toBeNull();
  });

  it("summarises a set for the project dialog, naming the stored id until that harness's catalog is in", () => {
    expect(reviewSummary(DEFAULT_REVIEW_SETTINGS)).toBe("Off");
    // No codex rows in the built-in list: the id stands in, never another harness's default.
    expect(reviewSummary({ ...DEFAULT_REVIEW_SETTINGS, beforeMerge: true })).toBe("gpt-6.1-sol · confirmed · 15 min");
    expect(reviewSummary({ ...DEFAULT_REVIEW_SETTINGS, beforeMerge: true, provider: "claude", model: "claude-haiku-5-5", blockOn: "any", maxMinutes: 5 })).toBe(
      "Claude Haiku 5.5 · any finding · 5 min",
    );
  });

  it("lists only the models the rules approve, keyed by the id the server stores", () => {
    const all = reviewerModelOptions("claude", "env", undefined);
    expect(all.some((o) => o.value === "claude-haiku-5-5")).toBe(true);
    const noHaiku = { ...DEFAULT_RULES, models: { ...DEFAULT_RULES.models, "claude:claude-haiku-5-5": { approved: false } } };
    const left = reviewerModelOptions("claude", "env", noHaiku);
    expect(left.some((o) => o.value === "claude-haiku-5-5")).toBe(false);
    expect(left.map((o) => o.value)).toEqual(
      all.map((o) => o.value).filter((v) => noHaiku.models[`claude:${v}`]?.approved === true),
    );
  });
});
