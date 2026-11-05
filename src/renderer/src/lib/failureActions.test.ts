import { describe, expect, it } from "vitest";
import type { FailureKind } from "@server/shared/events";
import { failureActions, failureNote, SIGN_IN_ELSEWHERE_NOTE } from "./failureActions";

const KINDS: FailureKind[] = [
  "oauth_expired",
  "account_unknown",
  "key_invalid",
  "token_expired",
  "rate_limited",
  "quota",
  "model_unavailable",
  "network",
  "harness_crashed",
  "turn_ended",
  "unknown",
];

const mac = { provider: "claude", signInHere: true };
const box = { provider: "claude", signInHere: false };
const labels = (kind: FailureKind, ctx = mac) => failureActions(kind, ctx).map((a) => a.label);

describe("failureActions", () => {
  it("never offers more than three actions and always ends on Retry", () => {
    for (const kind of KINDS) {
      for (const ctx of [mac, box, { provider: "cursor", signInHere: true }, { ...mac, roomElsewhere: false }, { ...box, roomElsewhere: true }]) {
        const actions = failureActions(kind, ctx);
        expect(actions.length, `${kind} ${JSON.stringify(ctx)}`).toBeLessThanOrEqual(3);
        expect(actions.at(-1)?.id).toBe("retry");
        expect(new Set(actions.map((a) => a.id)).size).toBe(actions.length);
      }
    }
  });

  it("a lapsed sign-in offers Sign in on the Mac and Route automatically with the note on the box", () => {
    expect(labels("oauth_expired")).toEqual(["Sign in", "Route automatically", "Retry"]);
    expect(failureNote("oauth_expired", mac)).toBeNull();
    expect(labels("oauth_expired", box)).toEqual(["Route automatically", "Pick another account", "Retry"]);
    expect(failureNote("oauth_expired", box)).toBe(SIGN_IN_ELSEWHERE_NOTE);
  });

  it("account failures route or pick another account", () => {
    for (const kind of ["account_unknown", "token_expired"] as const) {
      expect(labels(kind)).toEqual(["Route automatically", "Pick another account", "Retry"]);
      expect(labels(kind, box)).toEqual(["Route automatically", "Pick another account", "Retry"]);
      expect(failureNote(kind, box)).toBeNull();
    }
  });

  it("a cap leads with another account while one has room, else another model", () => {
    for (const kind of ["rate_limited", "quota"] as const) {
      // Room elsewhere, or a host that did not say.
      for (const ctx of [mac, box, { ...mac, roomElsewhere: true }]) {
        expect(labels(kind, ctx)).toEqual(["Route automatically", "Continue on another model", "Retry"]);
      }
      expect(labels(kind, { ...mac, roomElsewhere: false })).toEqual(["Continue on another model", "Retry"]);
      expect(labels(kind, { provider: "codex", signInHere: false, roomElsewhere: false })).toEqual(["Continue on another model", "Retry"]);
      expect(failureNote(kind, box)).toBeNull();
    }
  });

  it("a hidden model continues on another one", () => {
    expect(labels("model_unavailable")).toEqual(["Continue on another model", "Retry"]);
    expect(labels("model_unavailable", { provider: "codex", signInHere: false })).toEqual(["Continue on another model", "Retry"]);
  });

  it("network, a dead harness and the unknown only retry", () => {
    for (const kind of ["network", "harness_crashed", "turn_ended", "unknown"] as const) {
      expect(labels(kind)).toEqual(["Retry"]);
    }
  });

  it("a Meta thread: a refused key opens the accounts page, a missing key offers Add key, a limit routes to another key", () => {
    const meta = { provider: "claude", model: "muse-wonder-1.0", signInHere: true };
    expect(labels("key_invalid", meta)).toEqual(["Open accounts", "Retry"]);
    expect(labels("key_invalid", { ...meta, provider: "codex", model: "muse-spark-1.3", signInHere: false })).toEqual(["Open accounts", "Retry"]);
    expect(labels("account_unknown", meta)).toEqual(["Add key…", "Retry"]);
    expect(labels("rate_limited", meta)).toEqual(["Route automatically", "Pick another account", "Retry"]);
    // A Meta cap keeps its keys' set, whatever the room.
    expect(labels("quota", { ...meta, roomElsewhere: false })).toEqual(["Route automatically", "Pick another account", "Retry"]);
    // The harness's own model keeps its own set.
    expect(labels("account_unknown", mac)).toEqual(["Route automatically", "Pick another account", "Retry"]);
    expect(failureNote("key_invalid", meta)).toBeNull();
  });

  it("a provider without Aliax accounts never gets account actions; a cap there continues on another model", () => {
    for (const kind of ["oauth_expired", "account_unknown"] as const) {
      expect(labels(kind, { provider: "cursor", signInHere: true })).toEqual(["Retry"]);
    }
    for (const kind of ["rate_limited", "quota"] as const) {
      expect(labels(kind, { provider: "cursor", signInHere: true })).toEqual(["Continue on another model", "Retry"]);
    }
    expect(failureNote("oauth_expired", { provider: "cursor", signInHere: false })).toBeNull();
  });
});
