import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionStore } from "../../../lib/tcserver/store";
import { FakeMetaLink } from "../../../test/fakeMetaLink";
import { MasterRow } from "./MasterRow";
import { modelMarkName, modelMarkTip } from "../ModelMark";
import { standInMeta, type BoardRowRef } from "./useMasterModel";

/**
 * A board row for a child the store does not hold draws from the batch
 * list's stand-in alone (useRowMeta's fallback): with no model it draws
 * no model mark, and with one it draws the mark; neither throws. On
 * 2026-11-04 a stand-in without provider or model threw in modelMarkName
 * and blanked the window of a build without boundaries.
 */

const menu = { rowsFor: () => null, onPick: () => {}, onOpenChange: () => {} };
const ref = (fallback: BoardRowRef["fallback"]): BoardRowRef => ({
  key: fallback!.id,
  id: fallback!.id,
  planId: null,
  group: "running",
  done: false,
  environmentId: fallback!.environmentId,
  fallback,
  override: null,
});

describe("a board row for a stand-in child", () => {
  beforeEach(async () => {
    sessionStore.reset();
    sessionStore.attach(new FakeMetaLink());
    await sessionStore.ready();
  });
  afterEach(() => {
    cleanup();
    sessionStore.reset();
  });

  it("a stand-in with no model paints the row with no model mark; one with a model paints the mark", () => {
    const bare = standInMeta({ sessionId: "far", environmentId: "box", title: "Update 35 cont child", status: "running", threadType: "implementation" }, "m");
    const named = standInMeta({ sessionId: "near", environmentId: "box", title: "Named", status: "idle", provider: "codex", model: "gpt-6.1-sol", reasoning: "high" }, "m");
    const { container } = render(
      <>
        <MasterRow rowRef={ref(bare)} landed={false} host={null} onOpen={() => {}} menu={menu} />
        <MasterRow rowRef={ref(named)} landed={false} host={null} onOpen={() => {}} menu={menu} />
      </>,
    );
    const rows = container.querySelectorAll("[data-menu-id]");
    expect([...rows].map((r) => r.getAttribute("data-menu-id"))).toEqual(["far", "near"]);
    expect(rows[0].querySelector("[data-model]")).toBeNull();
    expect(rows[0].textContent).toContain("Update 35 cont child");
    expect(rows[1].querySelector("[data-model-name]")?.textContent).toBe("gpt-6.1-sol");
    expect(rows[1].querySelector("[data-model-effort]")?.textContent).toBe("High");
  });

  it("the mark's words take a missing model or provider", () => {
    expect(modelMarkName(undefined, undefined)).toBe("");
    expect(modelMarkName("claude", "claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelMarkTip({})).toBe("");
    expect(modelMarkTip({ reasoning: "high", context1m: true })).toBe("high effort, 1M context");
  });
});

describe("modelMarkTip's context", () => {
  it("names the window it is given, else 1M for a thread on the 1M window", () => {
    expect(modelMarkTip({ provider: "claude", model: "claude-opus-5-5", reasoning: "high" }, "Reviewer", "200k")).toBe(
      "Reviewer, Claude Opus 5.5, high effort, 200k context",
    );
    expect(modelMarkTip({ provider: "claude", model: "claude-opus-5-5", context1m: true })).toBe("Claude Opus 5.5, 1M context");
  });
});
