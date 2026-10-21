import { describe, expect, it } from "vitest";
import { memoryLine } from "./memoryLine";

const base = { id: "env_x", name: "box", connected: true, running: false, files: null, syncedAt: null, lastAttemptAt: null, error: null, conflicts: 0 };
const now = 1_000_000_000_000;

describe("memoryLine", () => {
  it("says never, the count and when with the conflicts, the error, or that it is running", () => {
    expect(memoryLine(base, now)).toBe("Memory: never synced");
    expect(memoryLine({ ...base, connected: false }, now)).toBe("Memory: never synced · not connected");
    expect(memoryLine({ ...base, files: 42, syncedAt: now - 120_000 }, now)).toBe("Memory: 42 files, synced 2m ago");
    expect(memoryLine({ ...base, files: 42, syncedAt: now - 120_000, conflicts: 1 }, now)).toBe("Memory: 42 files, synced 2m ago, 1 conflict");
    expect(memoryLine({ ...base, files: 1, syncedAt: now - 5_000, conflicts: 2 }, now)).toBe("Memory: 1 file, synced just now, 2 conflicts");
    expect(memoryLine({ ...base, files: 9, syncedAt: now - 3_600_000, error: "box closed the socket" }, now)).toBe("Memory: box closed the socket (last synced 1h ago)");
    expect(memoryLine({ ...base, running: true }, now)).toBe("Memory: syncing…");
  });
});
