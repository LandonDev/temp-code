import { afterEach, describe, expect, it, vi } from "vitest";
import { resetTaskFolds, setTaskFoldChoice, subscribeTaskFolds, taskFoldChoice, taskFoldKey, taskFoldOpen } from "./taskFold";

afterEach(() => resetTaskFolds());

describe("the board's task folds", () => {
  it("follow the thread by default: open while live, closed once done", () => {
    const key = taskFoldKey("m1", "a");
    expect(taskFoldChoice(key)).toBeUndefined();
    expect(taskFoldOpen(key, true)).toBe(true);
    expect(taskFoldOpen(key, false)).toBe(false);
  });

  it("let the person's choice win both ways, and clear back to the default", () => {
    const key = taskFoldKey("m1", "a");
    setTaskFoldChoice(key, false);
    expect(taskFoldOpen(key, true)).toBe(false);
    setTaskFoldChoice(key, true);
    expect(taskFoldOpen(key, false)).toBe(true);
    setTaskFoldChoice(key, undefined);
    expect(taskFoldChoice(key)).toBeUndefined();
    expect(taskFoldOpen(key, false)).toBe(false);
  });

  it("keep each row apart, and each master's rows apart", () => {
    setTaskFoldChoice(taskFoldKey("m1", "a"), false);
    expect(taskFoldOpen(taskFoldKey("m1", "b"), true)).toBe(true);
    expect(taskFoldOpen(taskFoldKey("m2", "a"), true)).toBe(true);
  });

  it("tell a subscriber on a change, and nothing when the choice already reads so", () => {
    const listener = vi.fn();
    const stop = subscribeTaskFolds(listener);
    setTaskFoldChoice(taskFoldKey("m1", "a"), false);
    expect(listener).toHaveBeenCalledTimes(1);
    setTaskFoldChoice(taskFoldKey("m1", "a"), false);
    expect(listener).toHaveBeenCalledTimes(1);
    setTaskFoldChoice(taskFoldKey("m1", "b"), undefined);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    setTaskFoldChoice(taskFoldKey("m1", "a"), undefined);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
