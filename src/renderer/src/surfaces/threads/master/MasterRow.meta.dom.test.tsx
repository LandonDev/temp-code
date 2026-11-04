import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionStore } from "../../../lib/tcserver/store";
import { FakeMetaLink } from "../../../test/fakeMetaLink";
import { MasterRow } from "./MasterRow";
import { modelMarkName, modelMarkTip } from "../ModelMark";
import { standInMeta, type BoardRowRef } from "./useMasterModel";

/** A board row on a Meta model draws Meta's mark in the harness's place
 *  and names the maker and the harness in the tip. */

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
const META_PATH = /^M6\.915 4\.03/;

describe("a board row on a Meta model", () => {
  beforeEach(async () => {
    sessionStore.reset();
    sessionStore.attach(new FakeMetaLink());
    await sessionStore.ready();
  });
  afterEach(() => {
    cleanup();
    sessionStore.reset();
  });

  it("draws Meta's mark and the model's name; a GPT row keeps the Codex mark", () => {
    const meta = standInMeta({ sessionId: "w", environmentId: "local", title: "Wonder", status: "running", provider: "codex", model: "muse-wonder-1.0", reasoning: "high" }, "m");
    const gpt = standInMeta({ sessionId: "g", environmentId: "local", title: "Sol", status: "running", provider: "codex", model: "gpt-6.1-sol", reasoning: "high" }, "m");
    const { container } = render(
      <>
        <MasterRow rowRef={ref(meta)} landed={false} host={null} onOpen={() => {}} menu={menu} />
        <MasterRow rowRef={ref(gpt)} landed={false} host={null} onOpen={() => {}} menu={menu} />
      </>,
    );
    const [wonder, sol] = [...container.querySelectorAll("[data-model]")];
    expect(wonder.textContent).toBe("Muse Wonder 1.0");
    expect(wonder.querySelector("svg path")?.getAttribute("d")).toMatch(META_PATH);
    expect(sol.querySelector("svg path")?.getAttribute("d") ?? "").not.toMatch(META_PATH);
  });

  it("names Meta and the harness in the tip, and the claude lane by its title", () => {
    expect(modelMarkName("claude", "muse-spark-1.3")).toBe("Muse Spark 1.3");
    expect(modelMarkTip({ provider: "codex", model: "muse-wonder-1.0", reasoning: "minimal" })).toBe(
      "Meta Muse Wonder 1.0 on Codex, minimal effort",
    );
    expect(modelMarkTip({ provider: "claude", model: "muse-spark-1.3", reasoning: "medium" })).toBe(
      "Meta Muse Spark 1.3 on Claude Code, medium effort",
    );
    expect(modelMarkTip({ provider: "claude", model: "claude-opus-5-5", reasoning: "high" })).toBe("Claude Opus 5.5, high effort");
  });
});
