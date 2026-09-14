import { describe, expect, it } from "vitest";
import type { Block } from "../lib/session";
import {
  addRanges,
  editDiff,
  findSeq,
  locateHunks,
  locateStart,
  parseApplyPatchFile,
  parseUnifiedDiff,
  previewToRows,
  revealDuration,
  rowsFromHunks,
} from "./diffRows";

function editBlock(name: string, input: unknown): Block {
  return {
    id: "b1",
    role: "assistant",
    tool: { callId: "c1", title: name, kind: "edit", status: "ok", detail: "", name, input },
  } as unknown as Block;
}

describe("previewToRows", () => {
  it("maps kinds, numbers by side and inserts gaps on jumps", () => {
    const rows = previewToRows([
      { number: 3, kind: "context", text: "a" },
      { number: 3, kind: "del", text: "old" },
      { number: 4, kind: "add", text: "new" },
      { number: 10, kind: "context", text: "z" },
    ]);
    expect(rows).toEqual([
      { type: "ctx", newNo: 3, text: "a" },
      { type: "del", oldNo: 3, text: "old" },
      { type: "add", newNo: 4, text: "new" },
      { type: "gap", text: "" },
      { type: "ctx", newNo: 10, text: "z" },
    ]);
  });
});

describe("editDiff", () => {
  it("Edit → one hunk of old and new lines", () => {
    const d = editDiff(editBlock("Edit", { old_string: "a\nb", new_string: "a\nc\nd" }));
    expect(d.hunks).toEqual([{ old: ["a", "b"], new: ["a", "c", "d"] }]);
    expect(d.rows).toBeUndefined();
  });
  it("MultiEdit → a hunk per edit, empty ones dropped", () => {
    const d = editDiff(
      editBlock("MultiEdit", {
        edits: [
          { old_string: "x", new_string: "y" },
          { old_string: "", new_string: "" },
        ],
      }),
    );
    expect(d.hunks).toEqual([{ old: ["x"], new: ["y"] }]);
  });
  it("Write → every line added, numbered from 1", () => {
    const d = editDiff(editBlock("Write", { content: "one\ntwo" }));
    expect(d.hunks).toEqual([{ old: [], new: ["one", "two"] }]);
    expect(d.rows).toEqual([
      { type: "add", newNo: 1, text: "one" },
      { type: "add", newNo: 2, text: "two" },
    ]);
  });
  it("Edit with no text yet carries no hunks", () => {
    expect(editDiff(editBlock("Edit", {})).hunks).toEqual([]);
  });
  it("apply_patch normalized single change parses its diff", () => {
    const d = editDiff(
      editBlock("apply_patch", [
        { path: "a.ts", kind: { type: "update" }, diff: "@@ -1,2 +1,2 @@\n a\n-b\n+c" },
      ]),
    );
    expect(d.hunks).toEqual([{ old: ["b"], new: ["c"] }]);
    expect(d.rows).toEqual([
      { type: "ctx", oldNo: 1, newNo: 1, text: "a" },
      { type: "del", oldNo: 2, text: "b" },
      { type: "add", newNo: 2, text: "c" },
    ]);
  });
  it("apply_patch raw text takes the first file's hunks", () => {
    const text =
      "*** Begin Patch\n*** Update File: a.ts\n@@\n a\n-b\n+c\n*** Update File: b.ts\n-x\n*** End Patch";
    expect(parseApplyPatchFile(text).hunks).toEqual([{ old: ["b"], new: ["c"] }]);
    expect(editDiff(editBlock("apply_patch", { input: text })).hunks).toEqual([
      { old: ["b"], new: ["c"] },
    ]);
  });
});

describe("parseUnifiedDiff", () => {
  it("numbers rows from the hunk header and gaps between hunks", () => {
    const { rows, hunks } = parseUnifiedDiff(
      "@@ -10,3 +10,3 @@\n a\n-b\n+B\n c\n@@ -20,1 +20,2 @@\n+z\n y",
    );
    expect(rows).toEqual([
      { type: "ctx", oldNo: 10, newNo: 10, text: "a" },
      { type: "del", oldNo: 11, text: "b" },
      { type: "add", newNo: 11, text: "B" },
      { type: "ctx", oldNo: 12, newNo: 12, text: "c" },
      { type: "gap", text: "" },
      { type: "add", newNo: 20, text: "z" },
      { type: "ctx", oldNo: 20, newNo: 21, text: "y" },
    ]);
    expect(hunks).toEqual([
      { old: ["b"], new: ["B"] },
      { old: [], new: ["z"] },
    ]);
  });
  it("a created file with no markers is all adds", () => {
    const { rows, hunks } = parseUnifiedDiff("a\nb", true);
    expect(rows.map((r) => r.newNo)).toEqual([1, 2]);
    expect(hunks).toEqual([{ old: [], new: ["a", "b"] }]);
  });
});

describe("locating hunks", () => {
  const file = ["h1", "h2", "keep", "new1", "new2", "tail", "end"].join("\n");
  it("findSeq and locateStart fall back to an edge line", () => {
    const lines = file.split("\n");
    expect(findSeq(lines, ["new1", "new2"])).toBe(3);
    expect(findSeq(lines, ["nope"])).toBe(-1);
    expect(locateStart(lines, { old: [], new: ["new1", "tweaked"] })).toBe(3);
    expect(locateStart(lines, { old: [], new: ["tweaked", "new2"] })).toBe(3);
    expect(locateStart(lines, { old: [], new: ["a", "b"] })).toBe(-1);
  });
  it("wraps a located hunk in two lines of context and shows the file's current lines", () => {
    const rows = locateHunks([{ old: ["gone"], new: ["new1", "new2"] }], file);
    expect(rows).toEqual([
      { type: "ctx", newNo: 2, text: "h2" },
      { type: "ctx", newNo: 3, text: "keep" },
      { type: "del", text: "gone" },
      { type: "add", newNo: 4, text: "new1" },
      { type: "add", newNo: 5, text: "new2" },
      { type: "ctx", newNo: 6, text: "tail" },
      { type: "ctx", newNo: 7, text: "end" },
    ]);
  });
  it("an unlocated hunk falls back to plain del/add rows, with a gap between hunks", () => {
    const rows = locateHunks(
      [
        { old: ["x"], new: ["y"] },
        { old: [], new: ["end"] },
      ],
      file,
    );
    expect(rows).toEqual([
      { type: "del", text: "x" },
      { type: "add", text: "y" },
      { type: "gap", text: "" },
      { type: "ctx", newNo: 5, text: "new2" },
      { type: "ctx", newNo: 6, text: "tail" },
      { type: "add", newNo: 7, text: "end" },
    ]);
    expect(rowsFromHunks([{ old: ["x"], new: ["y"] }])).toEqual([
      { type: "del", text: "x" },
      { type: "add", text: "y" },
    ]);
  });
  it("addRanges merges contiguous numbered adds", () => {
    expect(
      addRanges([
        { type: "add", newNo: 4, text: "" },
        { type: "add", newNo: 5, text: "" },
        { type: "ctx", newNo: 6, text: "" },
        { type: "add", newNo: 9, text: "" },
        { type: "add", text: "" },
      ]),
    ).toEqual([
      { start: 4, end: 5 },
      { start: 9, end: 9 },
    ]);
  });
});

describe("revealDuration", () => {
  it("grows 6ms a row from 150 and caps at 300", () => {
    expect(revealDuration(0)).toBe(150);
    expect(revealDuration(10)).toBe(210);
    expect(revealDuration(500)).toBe(300);
  });
});
