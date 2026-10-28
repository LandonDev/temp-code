import { describe, expect, it } from "vitest";
import { textLines } from "./textLines";

describe("textLines", () => {
  it("drops the empty part a final newline leaves", () => {
    expect(textLines("a\nb\nc\n")).toEqual(["a", "b", "c"]);
    expect(textLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  });
  it("counts nothing as no lines and a lone newline as one empty line", () => {
    expect(textLines("")).toEqual([]);
    expect(textLines("\n")).toEqual([""]);
  });
  it("keeps blank lines inside and one blank line before the final newline", () => {
    expect(textLines("a\n\nb\n\n")).toEqual(["a", "", "b", ""]);
  });
});
