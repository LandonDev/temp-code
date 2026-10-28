import { describe, expect, it } from "vitest";
import type { FailureKind } from "@server/shared/events";
import { failureActions, failureNote, SIGN_IN_ELSEWHERE_NOTE } from "./failureActions";

const KINDS: FailureKind[] = [
  "oauth_expired",
  "account_unknown",
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
      for (const ctx of [mac, box, { provider: "cursor", signInHere: true }]) {
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

  it("account and limit failures route or pick another account", () => {
    for (const kind of ["account_unknown", "token_expired", "rate_limited", "quota"] as const) {
      expect(labels(kind)).toEqual(["Route automatically", "Pick another account", "Retry"]);
      expect(labels(kind, box)).toEqual(["Route automatically", "Pick another account", "Retry"]);
      expect(failureNote(kind, box)).toBeNull();
    }
  });

  it("a hidden model offers another model", () => {
    expect(labels("model_unavailable")).toEqual(["Pick another model", "Retry"]);
    expect(labels("model_unavailable", { provider: "codex", signInHere: false })).toEqual(["Pick another model", "Retry"]);
  });

  it("network, a dead harness and the unknown only retry", () => {
    for (const kind of ["network", "harness_crashed", "turn_ended", "unknown"] as const) {
      expect(labels(kind)).toEqual(["Retry"]);
    }
  });

  it("a provider without Aliax accounts never gets account actions", () => {
    for (const kind of ["oauth_expired", "account_unknown", "rate_limited", "quota"] as const) {
      expect(labels(kind, { provider: "cursor", signInHere: true })).toEqual(["Retry"]);
    }
    expect(failureNote("oauth_expired", { provider: "cursor", signInHere: false })).toBeNull();
  });
});
