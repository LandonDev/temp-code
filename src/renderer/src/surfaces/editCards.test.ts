import { describe, expect, it } from "vitest";
import type { Block } from "../lib/session";
import { isInternalPath, memoryLabel } from "../lib/internalPath";
import { editPaths, patchSections, splitEditCards } from "./editCards";

const edit = (name: string, input: unknown, id = "b1"): Block => ({
  id,
  role: "tool",
  text: name,
  tool: { callId: "c1", name, input, status: "completed" },
});

describe("isInternalPath", () => {
  it("marks .temp-code bookkeeping but not worktree checkouts", () => {
    expect(isInternalPath("/p/.temp-code/PROJECT.md")).toBe(true);
    expect(isInternalPath(".temp-code/plan-abc.md")).toBe(true);
    expect(isInternalPath("/p/.temp-code")).toBe(true);
    expect(isInternalPath("/Users/me/.temp-code/worktrees/x/src/a.ts")).toBe(false);
    expect(isInternalPath("/p/src/a.ts")).toBe(false);
  });
  it("names what a set of internal paths is", () => {
    expect(memoryLabel(["/p/.temp-code/PROJECT.md"])).toBe("project memory");
    expect(memoryLabel(["/p/.temp-code/plan-k1.md"])).toBe("the plan");
    expect(memoryLabel(["/p/.temp-code/threads/t/notes.md"])).toBe("thread notes");
    expect(memoryLabel(["/p/.temp-code/x"])).toBe("app files");
  });
});

describe("splitEditCards", () => {
  it("leaves a plain edit alone", () => {
    const b = edit("Edit", { file_path: "/p/a.ts", old_string: "a", new_string: "b" });
    expect(splitEditCards(b)).toEqual({ cards: [b], internal: null });
    expect(splitEditCards(b)).toBe(splitEditCards(b));
  });
  it("routes a memory-file edit to the internal slot", () => {
    const b = edit("Write", { file_path: "/p/.temp-code/PROJECT.md", content: "x" });
    expect(splitEditCards(b)).toEqual({ cards: [], internal: b });
  });
  it("gives a multi-file patch one card per real file", () => {
    const changes = [
      { path: "/p/a.ts", kind: { type: "update" }, diff: "@@\n-a\n+b\n" },
      { path: "/p/.temp-code/PROJECT.md", kind: { type: "update" }, diff: "@@\n+m\n" },
      { path: "/p/b.ts", kind: { type: "add" }, diff: "+new\n" },
    ];
    const b = edit("apply_patch", changes);
    const { cards, internal } = splitEditCards(b);
    expect(cards.map((c) => c.id)).toEqual(["b1e0", "b1e1"]);
    expect(cards.map((c) => c.tool?.callId)).toEqual(["c1#e0", "c1#e1"]);
    expect(cards.map(editPaths)).toEqual([["/p/a.ts"], ["/p/b.ts"]]);
    expect(cards[0].tool?.status).toBe("completed");
    expect(internal?.id).toBe("b1m");
    expect(editPaths(internal!)).toEqual(["/p/.temp-code/PROJECT.md"]);
  });
  it("splits raw patch text into per-file patches", () => {
    const text = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "-a",
      "+b",
      "*** Add File: .temp-code/plan-k.md",
      "+plan",
      "*** End Patch",
    ].join("\n");
    expect(patchSections(text).map((s) => s.path)).toEqual(["src/a.ts", ".temp-code/plan-k.md"]);
    const { cards, internal } = splitEditCards(edit("apply_patch", { input: text }));
    expect(cards).toHaveLength(1);
    expect(cards[0].tool?.input).toEqual({
      input: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch",
    });
    expect(editPaths(cards[0])).toEqual(["src/a.ts"]);
    expect(editPaths(internal!)).toEqual([".temp-code/plan-k.md"]);
    const single = edit("apply_patch", "*** Begin Patch\n*** Update File: a.ts\n+x\n*** End Patch");
    expect(splitEditCards(single).cards[0]).toBe(single);
  });
});
