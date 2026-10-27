import { describe, expect, it } from "vitest";
import { harnessParts, setsText } from "./harnessLine";

const base = { id: "env_x", name: "box", connected: true, running: false, files: null, sets: null, syncedAt: null, lastAttemptAt: null, error: null };
const now = 1_000_000_000_000;

describe("harnessParts", () => {
  it("says never, the count and when, the error, or that it is running", () => {
    expect(harnessParts(base, now)).toEqual(["Never synced"]);
    expect(harnessParts({ ...base, connected: false }, now)).toEqual(["Never synced"]);
    expect(harnessParts({ ...base, files: 143, syncedAt: now - 120_000 }, now)).toEqual(["143 files", "synced 2m ago"]);
    expect(harnessParts({ ...base, files: 1, syncedAt: now - 5_000 }, now)).toEqual(["1 file", "synced just now"]);
    expect(harnessParts({ ...base, files: 9, syncedAt: now - 3_600_000, error: "box closed the socket" }, now)).toEqual(["box closed the socket", "last synced 1h ago"]);
    expect(harnessParts({ ...base, error: "box closed the socket" }, now)).toEqual(["box closed the socket"]);
    expect(harnessParts({ ...base, running: true }, now)).toEqual(["Syncing…"]);
  });
  it("names each set with files for the tooltip, in the set's order", () => {
    expect(setsText({ "Claude skills": 80, "Codex skills": 12, "Codex hooks": 1, "Shared skills": 30 })).toBe("Claude skills 80, Codex skills 12, Codex hooks 1, Shared skills 30");
    expect(setsText({ "Claude skills": 0 })).toBe("");
    expect(setsText(null)).toBe("");
  });
});
