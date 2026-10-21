import { describe, expect, it } from "vitest";
import { harnessLine } from "./harnessLine";

const base = { id: "env_x", name: "box", connected: true, running: false, files: null, syncedAt: null, lastAttemptAt: null, error: null };
const now = 1_000_000_000_000;

describe("harnessLine", () => {
  it("says never, the count and when, the error, or that it is running", () => {
    expect(harnessLine(base, now)).toBe("Harness config: never synced");
    expect(harnessLine({ ...base, connected: false }, now)).toBe("Harness config: never synced · not connected");
    expect(harnessLine({ ...base, files: 143, syncedAt: now - 120_000 }, now)).toBe("Harness config: 143 files, synced 2m ago");
    expect(harnessLine({ ...base, files: 1, syncedAt: now - 5_000 }, now)).toBe("Harness config: 1 file, synced just now");
    expect(harnessLine({ ...base, files: 9, syncedAt: now - 3_600_000, error: "box closed the socket" }, now)).toBe("Harness config: box closed the socket (last synced 1h ago)");
    expect(harnessLine({ ...base, running: true }, now)).toBe("Harness config: syncing…");
  });
});
