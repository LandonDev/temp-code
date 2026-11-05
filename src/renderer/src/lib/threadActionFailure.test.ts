import { describe, expect, it } from "vitest";
import { failureReason, failureToast } from "./threadActionFailure";

describe("a thread action that failed", () => {
  it("says the host's reason as a person reads it", () => {
    expect(failureReason(new Error("unknown session: abc"))).toBe("It is no longer on its host");
    expect(failureReason(new Error("socket closed"))).toBe("Its host is not connected");
    expect(failureReason(new Error("forbidden: session.delete needs admin."))).toBe("Forbidden: session.delete needs admin");
    expect(failureReason(new Error(""))).toBe("");
    expect(failureReason("plain words")).toBe("Plain words");
  });

  it("is two lines: what failed, then the thread and why", () => {
    expect(failureToast("delete it", "Fix the rail", new Error("offline"))).toEqual({ title: "Couldn't delete it", description: "Fix the rail: Offline" });
    expect(failureToast("stop it", "Fix the rail", new Error(""))).toEqual({ title: "Couldn't stop it", description: "Fix the rail" });
  });
});
