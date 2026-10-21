import { afterEach, describe, expect, it, vi } from "vitest";

const preconnect = vi.fn(() => Promise.resolve(true));
vi.mock("./tcserver/commands", () => ({ preconnect: (...args: unknown[]) => preconnect(...(args as [])) }));

const { askPreconnect, idleForPreconnect, resetPreconnectAsks, ASK_EVERY_MS } = await import("./preconnect");

describe("askPreconnect", () => {
  afterEach(() => {
    resetPreconnectAsks();
    preconnect.mockClear();
  });

  it("asks once per thread per half minute", () => {
    expect(askPreconnect("s1", 1_000)).toBe(true);
    expect(askPreconnect("s1", 1_000 + ASK_EVERY_MS - 1)).toBe(false);
    expect(askPreconnect("s2", 2_000)).toBe(true);
    expect(askPreconnect("s1", 1_000 + ASK_EVERY_MS)).toBe(true);
    expect(preconnect).toHaveBeenCalledTimes(3);
    expect(preconnect).toHaveBeenNthCalledWith(1, "s1");
  });

  it("swallows a refused ask", async () => {
    preconnect.mockImplementationOnce(() => Promise.reject(new Error("link down")));
    expect(askPreconnect("s3", 5_000)).toBe(true);
    await new Promise((ok) => setTimeout(ok, 0));
  });

  it("only an idle thread is worth a pre-connect", () => {
    expect(idleForPreconnect("idle")).toBe(true);
    expect(idleForPreconnect("error")).toBe(true);
    expect(idleForPreconnect(undefined)).toBe(true);
    expect(idleForPreconnect("running")).toBe(false);
    expect(idleForPreconnect("starting")).toBe(false);
    expect(idleForPreconnect("waiting")).toBe(false);
  });
});
