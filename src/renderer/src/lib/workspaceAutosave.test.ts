import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceAutosave } from "./workspaceAutosave";

type State = { n: number };

function harness(opts: { wait?: number; maxWait?: number; skip?: () => boolean } = {}) {
  const state: State = { n: 0 };
  const collect = vi.fn(() => ({ ...state }));
  const save = vi.fn();
  const autosave = createWorkspaceAutosave<State>({
    collect,
    key: (s) => String(s.n),
    save,
    skip: opts.skip,
    wait: opts.wait ?? 250,
    maxWait: opts.maxWait ?? 2000,
    setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimer: (id) => clearTimeout(id),
  });
  return { state, collect, save, autosave };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createWorkspaceAutosave", () => {
  it("a burst collects and saves once, after it quiets", () => {
    const { state, collect, save, autosave } = harness();
    for (let i = 1; i <= 10; i++) {
      state.n = i;
      autosave.touch();
      vi.advanceTimersByTime(50);
    }
    expect(collect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith({ n: 10 });
  });

  it("a touch that leaves the snapshot unchanged never cancels a pending save", () => {
    const { state, save, autosave } = harness();
    state.n = 1;
    autosave.touch();
    vi.advanceTimersByTime(200);
    // The old effect cleared its timer here and, seeing the same key,
    // scheduled nothing. The save was lost.
    autosave.touch();
    vi.advanceTimersByTime(300);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith({ n: 1 });
  });

  it("does not save again when nothing changed since the last save", () => {
    const { save, autosave } = harness();
    autosave.touch();
    vi.advanceTimersByTime(300);
    autosave.touch();
    vi.advanceTimersByTime(300);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("a burst that never quiets still saves within maxWait", () => {
    const { state, save, autosave } = harness({ wait: 250, maxWait: 1000 });
    for (let i = 1; i <= 30; i++) {
      state.n = i;
      autosave.touch();
      vi.advanceTimersByTime(100);
    }
    // 3 s of touches every 100 ms: one save per maxWait window at least.
    expect(save.mock.calls.length).toBeGreaterThanOrEqual(2);
    vi.advanceTimersByTime(300);
    expect(save).toHaveBeenLastCalledWith({ n: 30 });
  });

  it("skips while quitting", () => {
    let quitting = true;
    const { state, save, autosave } = harness({ skip: () => quitting });
    state.n = 1;
    autosave.touch();
    vi.advanceTimersByTime(300);
    expect(save).not.toHaveBeenCalled();
    quitting = false;
    autosave.touch();
    vi.advanceTimersByTime(300);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("cancel drops the pending save; the next touch arms again (StrictMode remount)", () => {
    const { state, save, autosave } = harness();
    state.n = 1;
    autosave.touch();
    autosave.cancel();
    vi.advanceTimersByTime(300);
    expect(save).not.toHaveBeenCalled();
    state.n = 2;
    autosave.touch();
    vi.advanceTimersByTime(300);
    expect(save).toHaveBeenCalledWith({ n: 2 });
  });
});
