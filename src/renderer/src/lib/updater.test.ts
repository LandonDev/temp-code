import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  announce: vi.fn(),
  apply: vi.fn(),
  check: vi.fn(),
  get: vi.fn(),
  message: vi.fn(),
  onStatus: vi.fn(),
  remember: vi.fn(),
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
vi.mock("./updateNotice", () => ({ rememberInstalledUpdate: mocks.remember }));

const status = (over: Record<string, unknown> = {}) => ({
  current: 95,
  latest: 96,
  notes: "Notes",
  canApply: true,
  phase: "idle",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  mocks.message.mockResolvedValue(undefined);
  mocks.get.mockResolvedValue(status());
});

describe("installPendingUpdate", () => {
  it("starts main's build and reports it", async () => {
    mocks.apply.mockResolvedValue(status({ phase: "building", step: "git" }));
    const { installPendingUpdate } = await import("./updater");
    const seen: string[] = [];

    const result = await installPendingUpdate((s) => seen.push(s.phase));

    expect(mocks.apply).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ phase: "building", step: "git" });
    expect(seen).toEqual(["building"]);
    expect(mocks.message).not.toHaveBeenCalled();
  });

  it("refuses in a dev instance that cannot apply", async () => {
    mocks.get.mockResolvedValue(status({ canApply: false }));
    const { installPendingUpdate } = await import("./updater");

    const result = await installPendingUpdate();

    expect(mocks.apply).not.toHaveBeenCalled();
    expect(result.phase).toBe("error");
    expect(mocks.message).toHaveBeenCalledOnce();
  });

  it("does nothing when no update is waiting", async () => {
    mocks.get.mockResolvedValue(status({ latest: 95 }));
    const { installPendingUpdate } = await import("./updater");

    const result = await installPendingUpdate();

    expect(mocks.apply).not.toHaveBeenCalled();
    expect(result).toEqual({ phase: "current", currentVersion: "95" });
  });

  it("surfaces a build that fails to start", async () => {
    mocks.apply.mockResolvedValue(status({ phase: "error", error: "boom" }));
    const { installPendingUpdate } = await import("./updater");

    const result = await installPendingUpdate();

    expect(result).toMatchObject({ phase: "error", error: "boom" });
    expect(mocks.message).toHaveBeenCalledWith(
      expect.stringContaining("boom"),
      expect.anything(),
    );
  });
});

describe("watchUpdateStatus", () => {
  it("records the installed version once main restarts", async () => {
    let push: ((s: ReturnType<typeof status>) => void) | null = null;
    mocks.onStatus.mockImplementation((cb) => {
      push = cb;
      return () => {};
    });
    const { watchUpdateStatus } = await import("./updater");
    const phases: string[] = [];
    watchUpdateStatus((s) => phases.push(s.phase));

    push!(status({ phase: "building" }));
    expect(mocks.remember).not.toHaveBeenCalled();
    push!(status({ phase: "restarting" }));
    push!(status({ phase: "restarting" }));

    expect(mocks.remember).toHaveBeenCalledExactlyOnceWith("96");
    expect(phases).toEqual(["building", "restarting", "restarting"]);
  });
});
