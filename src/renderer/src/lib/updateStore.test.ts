import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  announce: vi.fn(),
  check: vi.fn(),
  getVersion: vi.fn(),
  message: vi.fn(),
}));

vi.mock("./native", () => ({
  getVersion: mocks.getVersion,
  ask: vi.fn(),
  message: mocks.message,
  relaunch: vi.fn(),
  check: mocks.check,
}));
vi.mock("./sounds", () => ({ announceUpdateAvailable: mocks.announce }));

import {
  CHECK_INTERVAL_MS,
  FOCUS_RECHECK_MS,
  updateStore,
} from "./updateStore";

const fakeWindow = new EventTarget();

async function flush() {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", fakeWindow);
  mocks.getVersion.mockResolvedValue("0.2.0");
  mocks.check.mockResolvedValue(null);
});

afterEach(() => {
  updateStore.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("updateStore", () => {
  it("probes at launch and keeps the feed's notes on the snapshot", async () => {
    mocks.check.mockResolvedValue({
      version: "0.2.1",
      body: "## [0.2.1] - 2026-09-03\n\n### Changed\n\n- First auto-updating release\n",
    });

    updateStore.start();
    await flush();

    expect(mocks.check).toHaveBeenCalledOnce();
    expect(updateStore.getSnapshot()).toMatchObject({
      phase: "available",
      currentVersion: "0.2.0",
      availableVersion: "0.2.1",
      notes: expect.stringContaining("First auto-updating release"),
    });
    expect(mocks.announce).toHaveBeenCalledWith("0.2.1");
    expect(mocks.message).not.toHaveBeenCalled();
  });

  it("leaves a failed automatic probe idle and quiet", async () => {
    mocks.check.mockRejectedValue(new Error("network failed"));

    updateStore.start();
    await flush();

    expect(updateStore.getSnapshot()).toEqual({
      phase: "idle",
      currentVersion: "0.2.0",
    });
    expect(mocks.message).not.toHaveBeenCalled();
  });

  it("re-probes every half hour", async () => {
    updateStore.start();
    await flush();
    expect(mocks.check).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1);
    expect(mocks.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.check).toHaveBeenCalledTimes(2);
  });

  it("re-probes on focus only after five minutes", async () => {
    updateStore.start();
    await flush();

    await vi.advanceTimersByTimeAsync(FOCUS_RECHECK_MS - 1000);
    fakeWindow.dispatchEvent(new Event("focus"));
    await flush();
    expect(mocks.check).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    fakeWindow.dispatchEvent(new Event("focus"));
    await flush();
    expect(mocks.check).toHaveBeenCalledTimes(2);
  });

  it("notifies subscribers as the phase moves", async () => {
    const seen: string[] = [];
    updateStore.subscribe(() => seen.push(updateStore.getSnapshot().phase));

    updateStore.start();
    await flush();

    expect(seen).toEqual(["checking", "current"]);
  });
});
