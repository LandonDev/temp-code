import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionStore } from "../../../lib/tcserver/store";
import { FakeMetaLink } from "../../../test/fakeMetaLink";
import { MasterRow, MasterRowView } from "./MasterRow";
import FIXTURES from "./MasterRow.fixtures";
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
    expect(wonder.querySelector("[data-model-name]")?.textContent).toBe("Muse Wonder 1.0");
    expect(wonder.querySelector("[data-model-effort]")?.textContent).toBe("High");
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

describe("a board row's model mark", () => {
  afterEach(cleanup);

  it("ends with the effort after the model, and a model with none draws the model alone", () => {
    const marks = FIXTURES.map((f) => {
      const { container, unmount } = render(<MasterRowView {...(f.props as Parameters<typeof MasterRowView>[0])} />);
      const mark = container.querySelector("[data-row-title]")!.parentElement!.querySelector("[data-model]")!;
      const read = [mark.querySelector("[data-model-name]")?.textContent, mark.querySelector("[data-model-effort]")?.textContent ?? null];
      unmount();
      return read;
    });
    expect(marks).toEqual([
      ["Opus 5.5", "High"],
      ["Opus 5.5", "High"],
      [expect.any(String), "Extra high"],
      ["Opus 5.5", "Low"],
      [expect.any(String), null],
      ["Opus 5.5", "High"],
    ]);
  });

  it("gives the title's width up first", () => {
    const { container } = render(<MasterRowView {...(FIXTURES[0].props as Parameters<typeof MasterRowView>[0])} />);
    const title = container.querySelector("[data-row-title]")!.className;
    expect(title).toContain("shrink-[1000]");
    expect(title).toContain("min-w-16");
  });

  it("draws no model mark on its subagent lines", () => {
    const { container } = render(<MasterRowView {...(FIXTURES[0].props as Parameters<typeof MasterRowView>[0])} />);
    expect(container.querySelectorAll("[data-model]")).toHaveLength(1);
  });
  it("the model mark yields with the same delay as the actions arrive", () => {
    const meta = standInMeta({ sessionId: "w", environmentId: "local", title: "Wonder", status: "running", provider: "claude", model: "claude-opus-5-5", reasoning: "high" }, "m");
    const { container } = render(<MasterRow rowRef={ref(meta)} landed={false} host={null} onOpen={() => {}} menu={menu} />);
    const mark = container.querySelector("[data-model]")!.className;
    const actions = container.querySelector("[data-actions]")!.className;
    expect(mark).toContain("group-hover:opacity-0");
    expect(actions).toContain("group-hover:opacity-100");
    for (const cls of [mark, actions]) {
      expect(cls).toContain("group-hover:delay-(--delay-hover)");
      expect(cls).toContain("group-focus-visible:delay-(--dur-instant)");
      expect(cls).toContain("group-has-focus-visible:delay-(--dur-instant)");
      expect(cls).toContain("duration-(--dur-fast)");
      // Reduced motion keeps the fade (the actions' pointer turning on with it).
      expect(cls).toMatch(/motion-reduce:transition-(opacity|\[opacity,pointer-events\])/);
      // A click on the row holds neither.
      expect(cls).not.toContain("focus-within");
    }
    expect(actions).toContain("pointer-events-none");
    // Nothing acts before it shows: the pointer waits the same delay as the fade.
    expect(actions).toContain("transition-[opacity,pointer-events]");
    expect(actions).toContain("transition-discrete");
  });
});
