import { describe, expect, it } from "vitest";
import { DEGRADED_GRACE_MS, degradedFor, degradedText } from "./degraded";
import { IDLE_STATUS, type EnvironmentStatus } from "./types";

const at = (transport: EnvironmentStatus["transport"], extra: Partial<EnvironmentStatus> = {}): EnvironmentStatus => ({ ...IDLE_STATUS, transport, ...extra });

describe("degraded", () => {
  it("waits out the grace for a drop that may come back, never for a refused key or a stopped host", () => {
    expect(degradedFor(at("open"), 10_000)).toBeNull();
    expect(degradedFor(at("reconnecting"), DEGRADED_GRACE_MS - 1)).toBeNull();
    expect(degradedFor(at("reconnecting"), DEGRADED_GRACE_MS)?.kind).toBe("reconnecting");
    expect(degradedFor(at("connecting"), 0)).toBeNull();
    expect(degradedFor(at("unauthorized"), 0)?.kind).toBe("unauthorized");
    expect(degradedFor(at("offline"), 0)?.kind).toBe("offline");
  });
  it("words each state with the retry countdown", () => {
    const now = 1_000_000;
    expect(degradedText("box", { kind: "reconnecting", status: at("reconnecting", { nextRetryAt: now + 12_400 }) }, now)).toBe("box dropped; retrying in 13 s");
    expect(degradedText("box", { kind: "reconnecting", status: at("reconnecting", { nextRetryAt: null }) }, now)).toBe("Reconnecting to box…");
    expect(degradedText("box", { kind: "unauthorized", status: at("unauthorized") }, now)).toBe("box no longer accepts this key");
    expect(degradedText("box", { kind: "offline", status: at("offline", { lastError: "network down" }) }, now)).toBe("box is offline: network down");
    expect(degradedText("box", { kind: "connecting", status: at("connecting") }, now)).toBe("Connecting to box…");
  });
});
