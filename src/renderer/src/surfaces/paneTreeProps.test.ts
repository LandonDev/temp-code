import { describe, expect, it } from "vitest";
import { paneTreePropsEqual } from "./paneTreeProps";

const noop = () => {};
type Props = { visible: boolean; focusedId: string; onFocus: () => void; onOpen?: () => void };
const props = (over: Partial<Props> = {}): Props =>
  ({ visible: true, focusedId: "s1", onFocus: noop, ...over });

describe("paneTreePropsEqual", () => {
  it("skips a tree that was hidden and stays hidden, whatever else changed", () => {
    const before = props({ visible: false });
    const after = props({ visible: false, focusedId: "other", onFocus: () => {} });
    expect(paneTreePropsEqual(before, after)).toBe(true);
  });

  it("re-renders a visible tree only when a prop changed", () => {
    const before = props();
    expect(paneTreePropsEqual(before, { ...before })).toBe(true);
    expect(paneTreePropsEqual(before, props({ focusedId: "s2" }))).toBe(false);
    expect(paneTreePropsEqual(before, props({ onFocus: () => {} }))).toBe(false);
    expect(paneTreePropsEqual(before, props({ visible: false }))).toBe(false);
    expect(paneTreePropsEqual(props({ visible: false }), before)).toBe(false);
  });

  it("treats an added or dropped optional prop as a change", () => {
    const before = props();
    expect(paneTreePropsEqual(before, props({ onOpen: noop }))).toBe(false);
    expect(paneTreePropsEqual(props({ onOpen: noop }), before)).toBe(false);
  });
});
