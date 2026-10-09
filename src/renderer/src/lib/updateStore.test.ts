import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  announce: vi.fn(),
  apply: vi.fn(),
  check: vi.fn(),
  get: vi.fn(),
  message: vi.fn(),
  onStatus: vi.fn(),
}));

vi.mock("./native", () => ({
  ask: vi.fn(),
  message: mocks.message,
  updates: {
    get: mocks.get,
    check: mocks.check,
    apply: mocks.apply,
    onStatus: mocks.onStatus,
  },
}));
vi.mock("./sounds", () => ({ announceUpdateAvailable: mocks.announce }));

import {
  CHECK_INTERVAL_MS,
  FOCUS_RECHECK_MS,
  updateStore,
} from "./updateStore";

const fakeWindow = new EventTarget();

const status = (over: Record<string, unknown> = {}) => ({
  current: "1.0.95",
  latest: null as string | null,
  notes: "",
  canApply: true,
  checked: true,
  phase: "idle",
  ...over,
});

async function flush() {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

let pushStatus: ((s: ReturnType<typeof status>) => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", fakeWindow);
  mocks.get.mockResolvedValue(status());
  mocks.check.mockResolvedValue(status());
  mocks.onStatus.mockImplementation((cb) => {
    pushStatus = cb;
    return () => {
      pushStatus = null;
    };
  });
});

afterEach(() => {
  updateStore.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("updateStore", () => {
  it("probes at launch and keeps the release notes on the snapshot", async () => {
    mocks.check.mockResolvedValue(
      status({ latest: "1.0.96", notes: "Build tab shows behind-origin counts\n" }),
    );

    updateStore.start();
    await flush();

    expect(mocks.check).toHaveBeenCalledOnce();
    expect(updateStore.getSnapshot()).toMatchObject({
      phase: "available",
      currentVersion: "1.0.95",
      availableVersion: "1.0.96",
      notes: expect.stringContaining("behind-origin"),
    });
    expect(mocks.announce).toHaveBeenCalledWith("1.0.96");
    expect(mocks.message).not.toHaveBeenCalled();
  });

  it("leaves a failed automatic probe idle and quiet", async () => {
    mocks.check.mockRejectedValue(new Error("network failed"));

    updateStore.start();
    await flush();

    expect(updateStore.getSnapshot()).toEqual({
      phase: "idle",
      currentVersion: "1.0.95",
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

  it("mirrors main's download and restart offer and skips probes meanwhile", async () => {
    updateStore.start();
    await flush();

    pushStatus!(status({ latest: "1.0.96", phase: "downloading", percent: 37 }));
    expect(updateStore.getSnapshot()).toMatchObject({
      phase: "downloading",
      availableVersion: "1.0.96",
      percent: 37,
    });

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(mocks.check).toHaveBeenCalledTimes(1);

    pushStatus!(status({ latest: "1.0.96", phase: "ready" }));
    expect(updateStore.getSnapshot().phase).toBe("ready");
  });
});
