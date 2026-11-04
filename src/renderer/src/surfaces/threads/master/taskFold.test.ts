import { afterEach, describe, expect, it, vi } from "vitest";
import { isTaskFoldOpen, resetTaskFolds, setTaskFoldOpen, subscribeTaskFolds, taskFoldKey } from "./taskFold";

afterEach(() => resetTaskFolds());

describe("the board's task folds", () => {
  it("are closed by default", () => {
    expect(isTaskFoldOpen(taskFoldKey("m1", "a"))).toBe(false);
  });

  it("open and close by key", () => {
    const key = taskFoldKey("m1", "a");
    setTaskFoldOpen(key, true);
    expect(isTaskFoldOpen(key)).toBe(true);
    setTaskFoldOpen(key, false);
    expect(isTaskFoldOpen(key)).toBe(false);
  });

  it("keep each row apart, and each master's rows apart", () => {
    setTaskFoldOpen(taskFoldKey("m1", "a"), true);
    expect(isTaskFoldOpen(taskFoldKey("m1", "b"))).toBe(false);
    expect(isTaskFoldOpen(taskFoldKey("m2", "a"))).toBe(false);
  });

  it("tell a subscriber on a change, and nothing when the fold already reads so", () => {
    const listener = vi.fn();
    const stop = subscribeTaskFolds(listener);
    setTaskFoldOpen(taskFoldKey("m1", "a"), true);
    expect(listener).toHaveBeenCalledTimes(1);
    setTaskFoldOpen(taskFoldKey("m1", "a"), true);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    setTaskFoldOpen(taskFoldKey("m1", "a"), false);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
