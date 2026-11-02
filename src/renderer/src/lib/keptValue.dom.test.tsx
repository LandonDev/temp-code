import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { sameData, sameSet, useKept } from "./keptValue";

describe("useKept", () => {
  it("keeps the value it returned while the next reads the same, and takes a changed one", () => {
    const seen: ReadonlySet<string>[] = [];
    const Probe = ({ value }: { value: ReadonlySet<string> }) => {
      seen.push(useKept(value, sameSet));
      return null;
    };
    const first = new Set(["a", "b"]);
    const { rerender } = render(<Probe value={first} />);
    act(() => rerender(<Probe value={new Set(["b", "a"])} />));
    expect(seen.at(-1)).toBe(first);
    const changed = new Set(["a"]);
    act(() => rerender(<Probe value={changed} />));
    expect(seen.at(-1)).toBe(changed);
    act(() => rerender(<Probe value={new Set(["a"])} />));
    expect(seen.at(-1)).toBe(changed);
  });

  it("compares sets by their members", () => {
    expect(sameSet(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    expect(sameSet(new Set([1, 2]), new Set([1]))).toBe(false);
    expect(sameSet(new Set([1, 2]), new Set([1, 3]))).toBe(false);
  });

  it("compares plain data member by member and anything else by identity", () => {
    const f = () => 1;
    expect(sameData({ a: [1, { b: "x" }], c: null }, { c: null, a: [1, { b: "x" }] })).toBe(true);
    expect(sameData({ a: [1, 2] }, { a: [1, 3] })).toBe(false);
    expect(sameData({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameData({ on: f }, { on: f })).toBe(true);
    expect(sameData({ on: () => 1 }, { on: () => 1 })).toBe(false);
    expect(sameData(new Set([1]), new Set([1]))).toBe(false);
  });
});
