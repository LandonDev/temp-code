import { describe, expect, it } from "vitest";
import { minimalEdit } from "./minimalEdit";

describe("minimalEdit", () => {
  it("returns null for identical text", () => {
    expect(minimalEdit("abc", "abc")).toBeNull();
  });
  it("trims the common prefix and suffix", () => {
    expect(minimalEdit("hello world", "hello brave world")).toEqual({ start: 6, endCur: 6, text: "brave " });
  });
  it("covers a pure deletion", () => {
    expect(minimalEdit("a\nb\nc\n", "a\nc\n")).toEqual({ start: 2, endCur: 4, text: "" });
  });
  it("covers a full replacement", () => {
    expect(minimalEdit("xyz", "abc")).toEqual({ start: 0, endCur: 3, text: "abc" });
  });
  it("handles an append and a truncation", () => {
    expect(minimalEdit("ab", "abcd")).toEqual({ start: 2, endCur: 2, text: "cd" });
    expect(minimalEdit("abcd", "ab")).toEqual({ start: 2, endCur: 4, text: "" });
  });
});
