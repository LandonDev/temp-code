import { describe, expect, it } from "vitest";
import { deleteBody } from "./DeleteThreadDialog";

describe("the delete confirm's line", () => {
  it("a thread at work stops first, a queued one never starts, a settled one just goes", () => {
    for (const status of ["running", "starting", "waiting", "watching", "paused"] as const)
      expect(deleteBody(status)).toBe("It stops first, and its transcript is gone for good.");
    expect(deleteBody("queued")).toBe("It leaves the queue unstarted, and its transcript is gone for good.");
    for (const status of ["idle", "done", "error", "stopped", undefined] as const) expect(deleteBody(status)).toBe("Its transcript is gone for good.");
  });
});
