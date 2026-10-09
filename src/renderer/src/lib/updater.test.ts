import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  announce: vi.fn(),
  apply: vi.fn(),
  ask: vi.fn(),
  check: vi.fn(),
  get: vi.fn(),
  message: vi.fn(),
  onStatus: vi.fn(),
  remember: vi.fn(),
}));

vi.mock("./native", () => ({
  ask: mocks.ask,
  message: mocks.message,
  updates: {
    get: mocks.get,
    check: mocks.check,
    apply: mocks.apply,
    onStatus: mocks.onStatus,
  },
}));
vi.mock("./sounds", () => ({ announceUpdateAvailable: mocks.announce }));
vi.mock("./updateNotice", () => ({ rememberInstalledUpdate: mocks.remember }));

const status = (over: Record<string, unknown> = {}) => ({
  current: "1.0.198",
  latest: "1.0.199",
  notes: "Notes",
  canApply: true,
  checked: true,
  phase: "idle",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  mocks.message.mockResolvedValue(undefined);
  mocks.get.mockResolvedValue(status());
});

describe("snapshotFromStatus", () => {
  it("maps the feed's phases onto the renderer's", async () => {
    const { snapshotFromStatus } = await import("./updater");
    expect(snapshotFromStatus(status())).toMatchObject({
      phase: "available",
      currentVersion: "1.0.198",
      availableVersion: "1.0.199",
      notes: "Notes",
    });
    expect(snapshotFromStatus(status({ latest: null })).phase).toBe("current");
    expect(snapshotFromStatus(status({ latest: null, checked: false })).phase).toBe("idle");
    expect(snapshotFromStatus(status({ phase: "downloading", percent: 42 }))).toMatchObject({
      phase: "downloading",
      percent: 42,
      availableVersion: "1.0.199",
    });
    expect(snapshotFromStatus(status({ phase: "ready" })).phase).toBe("ready");
    expect(snapshotFromStatus(status({ phase: "error", error: "offline" }))).toMatchObject({
      phase: "error",
      error: "offline",
    });
  });
});

describe("installPendingUpdate", () => {
  it("starts the download and reports it", async () => {
    mocks.apply.mockResolvedValue(status({ phase: "downloading", percent: 0 }));
    const { installPendingUpdate } = await import("./updater");
    const seen: string[] = [];

    const result = await installPendingUpdate((s) => seen.push(s.phase));

    expect(mocks.apply).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ phase: "downloading", percent: 0 });
    expect(seen).toEqual(["downloading"]);
    expect(mocks.message).not.toHaveBeenCalled();
  });

  it("restarts into a downloaded release and remembers it for the notice", async () => {
    mocks.get.mockResolvedValue(status({ phase: "ready" }));
    mocks.apply.mockResolvedValue(status({ phase: "ready" }));
    const { installPendingUpdate } = await import("./updater");

    await installPendingUpdate();

    expect(mocks.remember).toHaveBeenCalledWith("1.0.199");
    expect(mocks.apply).toHaveBeenCalledOnce();
  });

  it("refuses in a dev instance that cannot apply", async () => {
    mocks.get.mockResolvedValue(status({ canApply: false }));
    const { installPendingUpdate } = await import("./updater");

    const result = await installPendingUpdate();

    expect(mocks.apply).not.toHaveBeenCalled();
    expect(result.phase).toBe("error");
    expect(mocks.message).toHaveBeenCalledOnce();
  });

  it("reports a download that did not start", async () => {
    mocks.apply.mockResolvedValue(status());
    const { installPendingUpdate } = await import("./updater");

    const result = await installPendingUpdate();

    expect(result).toMatchObject({ phase: "error", error: "The download did not start." });
  });
});

describe("runUpdateFlow", () => {
  it("announces an available release on an automatic check and stops there", async () => {
    mocks.check.mockResolvedValue(status());
    const { runUpdateFlow } = await import("./updater");

    const result = await runUpdateFlow(false);

    expect(result.phase).toBe("available");
    expect(mocks.announce).toHaveBeenCalledWith("1.0.199");
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("asks before downloading on a manual check", async () => {
    mocks.check.mockResolvedValue(status());
    mocks.ask.mockResolvedValue(true);
    mocks.apply.mockResolvedValue(status({ phase: "downloading", percent: 0 }));
    const { runUpdateFlow } = await import("./updater");

    const result = await runUpdateFlow(true);

    expect(mocks.ask).toHaveBeenCalledOnce();
    expect(mocks.ask.mock.calls[0][0]).toContain("Download it now?");
    expect(result.phase).toBe("downloading");
  });

  it("says so when current, only on a manual check", async () => {
    mocks.check.mockResolvedValue(status({ latest: null }));
    const { runUpdateFlow } = await import("./updater");

    await runUpdateFlow(false);
    expect(mocks.message).not.toHaveBeenCalled();
    await runUpdateFlow(true);
    expect(mocks.message).toHaveBeenCalledWith("You're on the latest release.", { title: "TempCode" });
  });

  it("leaves a running download alone", async () => {
    mocks.get.mockResolvedValue(status({ phase: "downloading", percent: 50 }));
    const { runUpdateFlow } = await import("./updater");

    const result = await runUpdateFlow(true);

    expect(mocks.check).not.toHaveBeenCalled();
    expect(result).toMatchObject({ phase: "downloading", percent: 50 });
  });
});

describe("watchUpdateStatus", () => {
  it("remembers the downloaded version once for the post-restart notice", async () => {
    const { watchUpdateStatus } = await import("./updater");
    const seen: string[] = [];
    watchUpdateStatus((s) => seen.push(s.phase));
    const push = mocks.onStatus.mock.calls[0][0] as (s: unknown) => void;

    push(status({ phase: "downloading", percent: 10 }));
    push(status({ phase: "ready" }));
    push(status({ phase: "ready" }));

    expect(seen).toEqual(["downloading", "ready", "ready"]);
    expect(mocks.remember).toHaveBeenCalledTimes(1);
    expect(mocks.remember).toHaveBeenCalledWith("1.0.199");
  });
});
