import { describe, expect, it } from "vitest";
import { needsYouCount } from "./dockBadge";

describe("needsYouCount", () => {
  it("counts waiting threads on any host and subagents alike", () => {
    expect(
      needsYouCount([
        { status: "waiting", archived: false },
        { status: "waiting", archived: false },
        { status: "waiting", archived: false },
      ]),
    ).toBe(3);
  });

  it("leaves out archived, running, failed, idle, paused and a plan ready to start", () => {
    expect(
      needsYouCount([
        { status: "waiting", archived: true },
        { status: "running", archived: false },
        { status: "error", archived: false },
        { status: "idle", archived: false },
        { status: "paused", archived: false },
        { status: "done", archived: false },
      ]),
    ).toBe(0);
  });
});
