import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { get, check, apply, message, ask } = vi.hoisted(() => ({
  get: vi.fn(),
  check: vi.fn(),
  apply: vi.fn(),
  message: vi.fn(),
  ask: vi.fn(),
}));

vi.mock("./native", () => ({
  ask,
  message,
  updates: { get, check, apply, onStatus: vi.fn() },
}));
vi.mock("./sounds", () => ({ announceUpdateAvailable: vi.fn() }));

import { runUpdateFlow } from "./updater";

const status = (over: Record<string, unknown> = {}) => ({
  current: "1.0.95",
  latest: null as string | null,
  notes: "",
  canApply: true,
  checked: true,
  phase: "idle",
  ...over,
});

describe("runUpdateFlow", () => {
  beforeEach(() => {
    get.mockResolvedValue(status());
  });
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("keeps automatic checks quiet when the feed is unreachable", async () => {
    check.mockResolvedValue(status({ phase: "error", error: "no feed" }));

    await expect(runUpdateFlow(false)).resolves.toMatchObject({
      phase: "error",
      currentVersion: "1.0.95",
    });
    expect(message).not.toHaveBeenCalled();
  });

  it("tells a manual check about a failed probe once", async () => {
    check.mockRejectedValue(new Error("network failed"));

    await expect(runUpdateFlow(true)).resolves.toMatchObject({
      phase: "error",
      error: "network failed",
    });
    expect(message).toHaveBeenCalledOnce();
    expect(message).toHaveBeenCalledWith(
      expect.stringContaining("network failed"),
      expect.anything(),
    );
  });

  it("tells a manual check when it is on the latest release", async () => {
    check.mockResolvedValue(status({ latest: null }));

    await expect(runUpdateFlow(true)).resolves.toEqual({
      phase: "current",
      currentVersion: "1.0.95",
      canApply: true,
    });
    expect(message).toHaveBeenCalledWith(
      "You're on the latest release.",
      expect.anything(),
    );
  });

  it("offers a manual install and starts it on yes", async () => {
    check.mockResolvedValue(status({ latest: "1.0.96", notes: "Hi" }));
    get.mockResolvedValue(status({ latest: "1.0.96", notes: "Hi" }));
    ask.mockResolvedValue(true);
    apply.mockResolvedValue(status({ latest: "1.0.96", phase: "downloading" }));

    await expect(runUpdateFlow(true)).resolves.toMatchObject({
      phase: "downloading",
    });
    expect(ask).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
  });

  it("leaves a running download alone", async () => {
    get.mockResolvedValue(status({ latest: "1.0.96", phase: "downloading" }));

    await expect(runUpdateFlow(true)).resolves.toMatchObject({
      phase: "downloading",
    });
    expect(check).not.toHaveBeenCalled();
  });
});
