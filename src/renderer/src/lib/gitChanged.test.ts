// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { notifyGitChanged, sameCheckout, subscribeGitChanged } from "./gitChanged";

describe("git-changed scope", () => {
  it("a listener bound to a checkout hears its own events and unscoped ones only", () => {
    const one = vi.fn();
    const two = vi.fn();
    const all = vi.fn();
    const stops = [
      subscribeGitChanged(one, "/w/one"),
      subscribeGitChanged(two, "/w/two"),
      subscribeGitChanged(all),
    ];
    notifyGitChanged("/w/one");
    notifyGitChanged("/w/one/src/deep");
    notifyGitChanged("/w/two");
    notifyGitChanged();
    notifyGitChanged("~");
    expect(one).toHaveBeenCalledTimes(4);
    expect(two).toHaveBeenCalledTimes(3);
    expect(all).toHaveBeenCalledTimes(5);
    for (const stop of stops) stop();
    notifyGitChanged("/w/one");
    expect(one).toHaveBeenCalledTimes(4);
  });

  it("a worktree under the repo and the repo itself count as one checkout", () => {
    expect(sameCheckout("/w/one", "/w/one/")).toBe(true);
    expect(sameCheckout("/w/one/.claude/worktrees/x", "/w/one")).toBe(true);
    expect(sameCheckout("/w/one", "/w/one-b")).toBe(false);
    expect(sameCheckout("/w/one", "/w/two")).toBe(false);
  });
});
