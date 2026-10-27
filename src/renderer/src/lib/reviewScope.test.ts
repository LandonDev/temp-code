import { describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "@server/shared/rules";
import { DEFAULT_REVIEW_SETTINGS } from "@server/shared/review";
import { parseReviewScope, reviewerModelOptions } from "./reviewScope";

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
