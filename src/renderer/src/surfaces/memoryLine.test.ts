import { describe, expect, it } from "vitest";
import { memoryParts } from "./memoryLine";

const base = { id: "env_x", name: "box", connected: true, running: false, files: null, syncedAt: null, lastAttemptAt: null, error: null, conflicts: 0 };
const now = 1_000_000_000_000;

describe("memoryParts", () => {
  it("says never, the count and when with the conflicts, the error, or that it is running", () => {
    expect(memoryParts(base, now)).toEqual(["Never synced"]);
    expect(memoryParts({ ...base, connected: false }, now)).toEqual(["Never synced"]);
    expect(memoryParts({ ...base, files: 42, syncedAt: now - 120_000 }, now)).toEqual(["42 files", "synced 2m ago"]);
    expect(memoryParts({ ...base, files: 42, syncedAt: now - 120_000, conflicts: 1 }, now)).toEqual(["42 files", "synced 2m ago", "1 conflict"]);
    expect(memoryParts({ ...base, files: 1, syncedAt: now - 5_000, conflicts: 2 }, now)).toEqual(["1 file", "synced just now", "2 conflicts"]);
    expect(memoryParts({ ...base, files: 9, syncedAt: now - 3_600_000, error: "box closed the socket" }, now)).toEqual(["box closed the socket", "last synced 1h ago"]);
    expect(memoryParts({ ...base, running: true }, now)).toEqual(["Syncing…"]);
  });
});
