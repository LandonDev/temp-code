import { describe, expect, it } from "vitest";
import {
  editors,
  editorsStore,
  forgetFiles,
  initialEditorsState,
  navigateTo,
  setFileDirty,
  setFileErrorCount,
} from "./editors";

describe("editor reducers keep the state object on a no-op", () => {
  const s = setFileErrorCount(initialEditorsState(["a"]), "a", 2);

  it("setFileDirty to the current state", () => {
    expect(setFileDirty(s, "a", true)).toBe(s);
    expect(setFileDirty(s, "b", false)).toBe(s);
  });

  it("setFileErrorCount to the current count", () => {
    expect(setFileErrorCount(s, "a", 2)).toBe(s);
    expect(setFileErrorCount(s, "b", 0)).toBe(s);
  });

  it("forgetFiles of files that are not dirty", () => {
    expect(forgetFiles(s, ["b", "c"])).toBe(s);
    expect(forgetFiles(s, [])).toBe(s);
  });
});

describe("editor reducers", () => {
  it("track dirty files and error counts, dropping zero counts", () => {
    let s = setFileDirty(initialEditorsState(), "a", true);
    expect([...s.dirtyFiles]).toEqual(["a"]);
    s = setFileDirty(s, "a", false);
    expect(s.dirtyFiles.size).toBe(0);
    s = setFileErrorCount(s, "a", 3);
    expect(s.fileErrorCounts.get("a")).toBe(3);
    s = setFileErrorCount(s, "a", 0);
    expect(s.fileErrorCounts.has("a")).toBe(false);
  });

  it("forgetFiles clears the dirty mark of closed files only", () => {
    const s = setFileErrorCount(initialEditorsState(["a", "b"]), "a", 1);
    const next = forgetFiles(s, ["a", "zzz"]);
    expect([...next.dirtyFiles]).toEqual(["b"]);
    expect(next.fileErrorCounts).toBe(s.fileErrorCounts);
  });

  it("navigateTo hands out a fresh token each time", () => {
    const first = navigateTo(initialEditorsState(), { path: "/repo/a.ts", line: 3 });
    const second = navigateTo(first, { path: "/repo/a.ts", line: 3 });
    expect(first.navigation?.token).toBe(1);
    expect(second.navigation?.token).toBe(2);
    expect(second.navigation).toMatchObject({ path: "/repo/a.ts", line: 3 });
  });
});

describe("editors store", () => {
  it("binds the reducers and a no-op notifies nobody", () => {
    editorsStore.setState(initialEditorsState(), true);
    let notified = 0;
    const off = editorsStore.subscribe(() => notified++);
    editors.setFileDirty("a", true);
    editors.setFileDirty("a", true);
    editors.forgetFiles(["zzz"]);
    expect(notified).toBe(1);
    expect(editorsStore.getState().dirtyFiles.has("a")).toBe(true);
    off();
  });
});
