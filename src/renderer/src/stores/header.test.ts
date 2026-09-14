import { describe, expect, it } from "vitest";
import { header, headerStore, initialHeaderState, publish, tabProjectOf } from "./header";

describe("header publish", () => {
  it("keeps the state object when every field is the same", () => {
    const s = initialHeaderState();
    expect(publish(s, { ...s })).toBe(s);
  });

  it("takes only the fields that changed", () => {
    const s = initialHeaderState();
    const stripTabs = ["a", "b"];
    const next = publish(s, { ...s, stripTabs });
    expect(next).not.toBe(s);
    expect(next.stripTabs).toBe(stripTabs);
    expect(next.tabProjects).toBe(s.tabProjects);
    expect(next.model).toBe(s.model);
    expect(next.chipThreads).toBe(s.chipThreads);
  });

  it("the bound publish notifies only on a change and exposes tab projects", () => {
    headerStore.setState(initialHeaderState(), true);
    let notified = 0;
    const off = headerStore.subscribe(() => notified++);
    header.publish(headerStore.getState());
    expect(notified).toBe(0);
    header.publish({ ...headerStore.getState(), tabProjects: new Map([["t1", "repo"]]) });
    expect(notified).toBe(1);
    expect(tabProjectOf("t1")).toBe("repo");
    expect(tabProjectOf("t2")).toBeUndefined();
    off();
  });
});
