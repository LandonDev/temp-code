// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { projectFolds, projectFoldsStore, projectOpen, toggleProject } from "./projectFolds";

describe("project folds", () => {
  beforeEach(() => {
    localStorage.clear();
    projectFolds.reload();
  });

  it("a project is open by default", () => {
    expect(projectOpen({ closed: {} }, "p")).toBe(true);
  });

  it("closing makes an entry and reopening drops it", () => {
    const shut = toggleProject({ closed: {} }, "p");
    expect(shut.closed).toEqual({ p: true });
    expect(projectOpen(shut, "p")).toBe(false);
    expect(toggleProject(shut, "p").closed).toEqual({});
  });

  it("a close persists across a reload", () => {
    projectFolds.toggle("p");
    expect(JSON.parse(localStorage.getItem("monocode.tc.projectFolds")!)).toEqual(["p"]);
    projectFolds.reload();
    expect(projectOpen(projectFoldsStore.getState(), "p")).toBe(false);
    projectFolds.toggle("p");
    projectFolds.reload();
    expect(projectOpen(projectFoldsStore.getState(), "p")).toBe(true);
  });
});
