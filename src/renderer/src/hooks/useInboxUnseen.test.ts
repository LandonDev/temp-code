import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The rail badge once polled GitHub for every project every 30 s and on
 * every focus; that fork storm froze the machine. The hook must stay a
 * cache read: no timers, no visibility listeners, no requests.
 */
describe("useInboxUnseen", () => {
  it("reads the cache and never fetches", () => {
    const source = readFileSync(new URL("./useInboxUnseen.ts", import.meta.url), "utf8");
    for (const banned of [
      "setInterval",
      "setTimeout",
      "visibilitychange",
      "listInboxItems",
      "invoke",
      "addEventListener",
    ]) {
      expect(source, `must not use ${banned}`).not.toContain(banned);
    }
  });
});
