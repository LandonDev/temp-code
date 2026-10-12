import { describe, expect, it } from "vitest";
import type { LayoutNode } from "./layout";
import { nudgeReachesScreen } from "./nudgeScope";

const leaf = (id: string): LayoutNode => ({ type: "leaf", id });
const tab = (focusedId: string, ...others: string[]) => ({
  focusedId,
  layout: {
    type: "split" as const,
    id: "root",
    dir: "row" as const,
    children: [leaf(focusedId), ...others.map(leaf)],
    sizes: [],
  },
});
const base = {
  activeTab: tab("s1", "s2"),
  projectCwd: "/w/app",
  heldCheckout: (cwd: string) => cwd === "/w/held",
};

describe("nudgeReachesScreen", () => {
  it("the active tab's sessions always reach the screen", () => {
    expect(nudgeReachesScreen({ ...base, sessionId: "s1", workCwd: "/elsewhere" })).toBe(true);
    expect(nudgeReachesScreen({ ...base, sessionId: "s2", workCwd: "/elsewhere" })).toBe(true);
  });

  it("a background session reaches the screen only through a checkout that is shown", () => {
    expect(nudgeReachesScreen({ ...base, sessionId: "bg", workCwd: "/w/app/" })).toBe(true);
    expect(nudgeReachesScreen({ ...base, sessionId: "bg", workCwd: "/w/held" })).toBe(true);
    expect(nudgeReachesScreen({ ...base, sessionId: "bg", workCwd: "/w/other" })).toBe(false);
    expect(nudgeReachesScreen({ ...base, sessionId: "bg", workCwd: "~" })).toBe(false);
  });

  it("with no tab open, only the window's folder counts", () => {
    expect(nudgeReachesScreen({ ...base, activeTab: undefined, sessionId: "s1", workCwd: "/w/other" })).toBe(false);
    expect(nudgeReachesScreen({ ...base, activeTab: undefined, sessionId: "s1", workCwd: "/w/app" })).toBe(true);
  });
});
