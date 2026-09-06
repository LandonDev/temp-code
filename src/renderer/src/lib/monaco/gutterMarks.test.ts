import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { gutterMarks } from "./gutterMarks";

const marksFor = (head: string, current: string) => {
  const b = Text.of(current.split("\n"));
  return gutterMarks(Chunk.build(Text.of(head.split("\n")), b), b);
};

describe("gutterMarks", () => {
  it("marks inserted lines as added", () => {
    expect(marksFor("a\nb\nc", "a\nx\ny\nb\nc")).toEqual([
      { line: 2, kind: "add" },
      { line: 3, kind: "add" },
    ]);
  });
  it("marks edited lines as changed", () => {
    expect(marksFor("a\nb\nc", "a\nB\nc")).toEqual([{ line: 2, kind: "change" }]);
  });
  it("marks a deletion on the following line", () => {
    expect(marksFor("a\nb\nc", "a\nc")).toEqual([{ line: 2, kind: "delete" }]);
  });
  it("marks a trailing deletion on the last line", () => {
    expect(marksFor("a\nb\nc", "a\nb")).toEqual([{ line: 2, kind: "delete" }]);
  });
  it("marks nothing when the texts match", () => {
    expect(marksFor("a\nb", "a\nb")).toEqual([]);
  });
});
