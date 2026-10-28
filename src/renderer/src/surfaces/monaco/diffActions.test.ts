import { describe, expect, it } from "vitest";
import { changeLineOffsets, changeOffset, minimalEdit, positionAt } from "./diffActions";

const text = "one\ntwo\nthree\n";

describe("diffActions", () => {
  it("a change starts at its first line; a pure deletion at the line after it, clamped", () => {
    expect(changeOffset(text, { modifiedStartLineNumber: 2, modifiedEndLineNumber: 3 })).toBe(4);
    expect(changeOffset(text, { modifiedStartLineNumber: 0, modifiedEndLineNumber: 0 })).toBe(0);
    expect(changeOffset(text, { modifiedStartLineNumber: 1, modifiedEndLineNumber: 0 })).toBe(4);
    expect(changeOffset(text, { modifiedStartLineNumber: 9, modifiedEndLineNumber: 0 })).toBe(14);
  });

  it("lists the start of every line a change covers, one offset for a pure deletion", () => {
    expect(changeLineOffsets(text, { modifiedStartLineNumber: 2, modifiedEndLineNumber: 3 })).toEqual([4, 8]);
    expect(changeLineOffsets(text, { modifiedStartLineNumber: 1, modifiedEndLineNumber: 0 })).toEqual([4]);
  });

  it("finds the smallest replacement", () => {
    expect(minimalEdit("one\nTWO\nthree", "one\ntwo\nthree")).toEqual({ start: 4, end: 7, insert: "two" });
    expect(minimalEdit("a\nb\n", "a\n")).toEqual({ start: 2, end: 4, insert: "" });
    expect(minimalEdit("same", "same")).toEqual({ start: 4, end: 4, insert: "" });
  });

  it("turns an offset into a line and column", () => {
    expect(positionAt(text, 0)).toEqual({ lineNumber: 1, column: 1 });
    expect(positionAt(text, 5)).toEqual({ lineNumber: 2, column: 2 });
    expect(positionAt(text, 14)).toEqual({ lineNumber: 4, column: 1 });
  });
});
