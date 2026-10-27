import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { Chunk } from "@codemirror/merge";
import {
  findChunk,
  hunksOf,
  gitThemeSpec,
  revertChunkText,
  stageChunkText,
  deletedLineTexts,
  diffLineStatsFromState,
  overviewTicks,
  stateWithGitDoc,
  stateWithGitOriginal,
  stateWithGitOriginalUpdated,
} from "./editorGit";

describe("stageChunkText", () => {
  it("stages a whole added hunk and leaves later hunks unstaged", () => {
    const original = "alpha\nbeta\ngamma\ndelta\n";
    const current = "alpha\nBETA\ngamma\nDELTA\n";
    const beta = Text.of(current.split("\n")).line(2).from;
    expect(stageChunkText(original, current, beta)).toBe(
      "alpha\nBETA\ngamma\ndelta\n",
    );
  });

  it("stages selected added lines and excludes the rest of the hunk", () => {
    const original = "alpha\ngamma\n";
    const current = "alpha\nbeta\ndelta\ngamma\n";
    const doc = Text.of(current.split("\n"));
    const beta = doc.line(2);
    expect(
      stageChunkText(original, current, beta.from, {
        from: beta.from,
        to: beta.to,
      }),
    ).toBe("alpha\nbeta\ngamma\n");
  });

  it("stages a deleted hunk", () => {
    const original = "alpha\nbeta\ngamma\n";
    const current = "alpha\ngamma\n";
    const pos = Text.of(current.split("\n")).line(2).from;
    expect(stageChunkText(original, current, pos)).toBe(current);
  });
});

describe("revertChunkText", () => {
  it("restores a deleted line", () => {
    const original = "alpha\nbeta\ngamma\n";
    const current = "alpha\ngamma\n";
    const reverted = revertChunkText(original, current, 6);
    expect(reverted).toBe(original);
  });

  it("removes an added line", () => {
    const original = "alpha\ngamma\n";
    const current = "alpha\nbeta\ngamma\n";
    const reverted = revertChunkText(original, current, 6);
    expect(reverted).toBe(original);
  });

  it("restores a modified hunk", () => {
    const original = "alpha\nbeta\ngamma\n";
    const current = "alpha\nBETA\ngamma\n";
    const reverted = revertChunkText(original, current, 6);
    expect(reverted).toBe(original);
  });

  it("returns null when the cursor is on an unchanged line", () => {
    const original = "alpha\nbeta\ngamma\n";
    const current = "alpha\nBETA\ngamma\n";
    expect(revertChunkText(original, current, 0)).toBeNull();
  });

  it("reverts selected added lines and keeps the rest of the hunk", () => {
    const original = "alpha\ngamma\n";
    const current = "alpha\nbeta\ndelta\ngamma\n";
    const doc = Text.of(current.split("\n"));
    const beta = doc.line(2);
    expect(
      revertChunkText(original, current, beta.from, {
        from: beta.from,
        to: beta.to,
      }),
    ).toBe("alpha\ndelta\ngamma\n");
  });
});

describe("deletedLineTexts", () => {
  it("returns the removed lines for a deletion hunk", () => {
    const original = Text.of("alpha\nbeta\ngamma\n".split("\n"));
    const current = Text.of("alpha\ngamma\n".split("\n"));
    const chunks = Chunk.build(original, current, {
      scanLimit: 5_000,
      timeout: 100,
    });
    const chunk = chunks.find((entry) => entry.fromA !== entry.toA);
    expect(chunk).toBeTruthy();
    expect(deletedLineTexts(original, chunk!)).toEqual(["beta"]);
  });
});

describe("overviewTicks", () => {
  it("maps added, deleted, and modified hunks", () => {
    const added = Chunk.build(
      Text.of("alpha\ngamma\n".split("\n")),
      Text.of("alpha\nbeta\ngamma\n".split("\n")),
    );
    expect(overviewTicks(Text.of("alpha\nbeta\ngamma\n".split("\n")), added, null)).toEqual([
      { kind: "add", top: 1 / 4, size: 1 / 4, pos: 6 },
    ]);

    const original = Text.of("alpha\nbeta\ngamma\n".split("\n"));
    const deletedDoc = Text.of("alpha\ngamma\n".split("\n"));
    const deleted = Chunk.build(original, deletedDoc);
    const delTicks = overviewTicks(deletedDoc, deleted, original);
    expect(delTicks).toHaveLength(1);
    expect(delTicks[0]?.kind).toBe("del");

    const modified = Chunk.build(
      Text.of("alpha\nbeta\ngamma\n".split("\n")),
      Text.of("alpha\nBETA\ngamma\n".split("\n")),
    );
    const modTicks = overviewTicks(
      Text.of("alpha\nBETA\ngamma\n".split("\n")),
      modified,
      null,
    );
    expect(modTicks[0]?.kind).toBe("mod");
  });
});

describe("findChunk", () => {
  it("finds a pure deletion on the following line", () => {
    const original = Text.of("alpha\nbeta\ngamma\n".split("\n"));
    const current = Text.of("alpha\ngamma\n".split("\n"));
    const chunks = Chunk.build(original, current, {
      scanLimit: 5_000,
      timeout: 100,
    });
    const chunk = findChunk(current, chunks, current.line(2).from);
    expect(chunk).toBeTruthy();
    expect(chunk?.fromA).not.toBe(chunk?.toA);
    expect(chunk?.fromB).toBe(chunk?.toB);
  });
});

describe("stateWithGitOriginal", () => {
  it("decorates added, deleted, and modified hunks", () => {
    expect(() =>
      stateWithGitOriginal("alpha\nBETA\ngamma\n", "alpha\nbeta\ngamma\n"),
    ).not.toThrow();
    expect(() =>
      stateWithGitOriginal("alpha\nbeta\ngamma\n", "alpha\ngamma\n"),
    ).not.toThrow();
    expect(() =>
      stateWithGitOriginal("alpha\ngamma\n", "alpha\nbeta\ngamma\n"),
    ).not.toThrow();
    expect(() =>
      stateWithGitOriginal("hello\nworld\n", ""),
    ).not.toThrow();
  });

  it("rebuilds hunks when the whole document is replaced", () => {
    const original = "alpha\nbeta\ngamma\n";
    const clean = stateWithGitOriginal(original, original);
    expect(diffLineStatsFromState(clean)).toEqual({
      additions: 0,
      deletions: 0,
    });

    const replaced = stateWithGitDoc(clean, "alpha\nBETA\ngamma\n");
    expect(diffLineStatsFromState(replaced)).toEqual({
      additions: 1,
      deletions: 1,
    });
  });

  it("rebuilds hunks when git original changes without a doc edit", () => {
    const current = "alpha\nBETA\ngamma\n";
    const matching = stateWithGitOriginal(current, current);
    expect(diffLineStatsFromState(matching)).toEqual({
      additions: 0,
      deletions: 0,
    });

    const updated = stateWithGitOriginalUpdated(
      matching,
      "alpha\nbeta\ngamma\n",
    );
    expect(diffLineStatsFromState(updated)).toEqual({
      additions: 1,
      deletions: 1,
    });
  });

  it("keeps incremental edits on the live hunk path", () => {
    const original = "alpha\nbeta\ngamma\n";
    const state = stateWithGitOriginal(original, original).update({
      changes: { from: 6, insert: "X" },
    }).state;
    expect(diffLineStatsFromState(state).additions).toBeGreaterThan(0);
  });

  it("clears hunks when a disk replace matches git original", () => {
    const original = "alpha\nbeta\ngamma\n";
    const dirty = stateWithGitOriginal("alpha\nBETA\ngamma\n", original);
    expect(diffLineStatsFromState(dirty)).toEqual({
      additions: 1,
      deletions: 1,
    });

    const restored = stateWithGitDoc(dirty, original);
    expect(diffLineStatsFromState(restored)).toEqual({
      additions: 0,
      deletions: 0,
    });
  });
});

describe("gitThemeSpec", () => {
  const values = Object.values(gitThemeSpec).flatMap((rule) => Object.values(rule as Record<string, string>));

  it("is written in tokens: no hex colour and no inset left bar", () => {
    for (const value of values) {
      expect(value).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(value).not.toContain("inset 3px");
    }
  });

  it("tints added and removed lines with success and destructive at 10%", () => {
    expect(gitThemeSpec[".cm-gitInsertedLine"].backgroundColor).toBe(
      "color-mix(in srgb, var(--color-success) 10%, transparent)",
    );
    expect(gitThemeSpec[".cm-gitDeletedLine"].backgroundColor).toBe(
      "color-mix(in srgb, var(--color-destructive) 10%, transparent)",
    );
  });
});

describe("hunksOf", () => {
  it("answers one hunk per change with its span in the current file and its counts", () => {
    const hunks = hunksOf("a\nb\nc\nd\ne\nf\ng\nh\n", "a\nB\nc\nd\ne\nf\nG\nG2\nh\n");
    expect(hunks.map(({ from, to, additions, deletions }) => ({ from, to, additions, deletions }))).toEqual([
      { from: 2, to: 2, additions: 1, deletions: 1 },
      { from: 7, to: 8, additions: 2, deletions: 1 },
    ]);
    expect(stageChunkText("a\nb\nc\nd\ne\nf\ng\nh\n", "a\nB\nc\nd\ne\nf\nG\nG2\nh\n", hunks[0].pos)).toBe("a\nB\nc\nd\ne\nf\ng\nh\n");
  });

  it("answers nothing when the versions match", () => {
    expect(hunksOf("same\n", "same\n")).toEqual([]);
  });
});
