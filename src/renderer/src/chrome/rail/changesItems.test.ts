import { describe, expect, it } from "vitest";
import type { CompareResult } from "@server/shared/domain";
import type { GitDiffIndex } from "../../lib/fs";
import { changesItems, estimateItem, foldKey } from "./changesItems";

const file = (relative: string, over: Partial<GitDiffIndex["files"][number]> = {}) => ({
  path: `/p/${relative}`,
  relative,
  status: "modified",
  additions: 1,
  deletions: 0,
  staged: false,
  unstaged: true,
  ...over,
});
const indexOf = (files: GitDiffIndex["files"]): GitDiffIndex => ({
  branch: "feat",
  files,
  additions: 0,
  deletions: 0,
  remote: null,
  upstream: null,
  defaultBranch: null,
  ahead: 0,
  behind: 0,
  aheadOfDefault: 0,
});
const compare = (over: Partial<CompareResult> = {}): CompareResult => ({
  target: "master",
  mergeBase: "base",
  ahead: 1,
  behind: 0,
  ours: [{ sha: "a1", subject: "One", authoredAt: 0 }],
  theirs: [],
  files: [{ path: "src/x.ts", adds: 1, dels: 0, status: "modified" }],
  ...over,
});
const shape = (items: ReturnType<typeof changesItems>) => items.map((i) => `${i.gap ? "+" : ""}${i.key}`);

describe("changesItems", () => {
  it("loads, then says nothing changed, with the Against group after a gap", () => {
    expect(shape(changesItems(null))).toEqual(["loading"]);
    expect(shape(changesItems(indexOf([]), { compare: undefined }))).toEqual(["empty", "+against"]);
  });

  it("names the groups only when both exist, staged first, each file in the index's order", () => {
    const one = changesItems(indexOf([file("b.ts"), file("a.ts")]));
    expect(shape(one)).toEqual(["u:b.ts", "u:a.ts"]);
    const both = changesItems(indexOf([file("a.ts", { staged: true, unstaged: true }), file("b.ts", { staged: true, unstaged: false }), file("c.ts")]));
    expect(shape(both)).toEqual(["h:staged", "s:a.ts", "s:b.ts", "+h:unstaged", "u:a.ts", "u:c.ts"]);
    expect(both[0]).toMatchObject({ kind: "heading", label: "Staged", count: 2 });
    expect(both[3]).toMatchObject({ kind: "heading", label: "Changes", count: 2 });
    // A file's row key is its fold's key, and its menu id.
    expect(both[1]!.key).toBe(foldKey("staged", "a.ts"));
  });

  it("the Against group: its head, its files, then the commits fold", () => {
    const items = changesItems(indexOf([file("a.ts")]), { compare: compare() });
    expect(shape(items)).toEqual(["u:a.ts", "+against", "a:src/x.ts", "commits"]);
    expect(shape(changesItems(indexOf([]), { compare: compare({ ours: [], files: [] }) }))).toEqual(["empty", "+against"]);
    expect(shape(changesItems(indexOf([]), { compare: null }))).toEqual(["empty", "+against"]);
  });

  it("keys are unique however many files", () => {
    const files = Array.from({ length: 10_000 }, (_, i) => file(`f${i}.ts`, { status: "untracked", staged: i % 2 === 0, unstaged: true }));
    const items = changesItems(indexOf(files), { compare: compare() });
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
    expect(items).toHaveLength(2 + 5_000 + 10_000 + 3);
  });

  it("estimates a row's height with its gap", () => {
    const [heading, row, second] = changesItems(indexOf([file("a.ts", { staged: true, unstaged: true })]));
    expect(estimateItem(heading!)).toBe(24);
    expect(estimateItem(row!)).toBe(28);
    expect(estimateItem(second!)).toBe(24 + 16);
  });
});
