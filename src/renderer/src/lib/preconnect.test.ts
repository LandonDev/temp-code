import { afterEach, describe, expect, it, vi } from "vitest";

const preconnect = vi.fn(() => Promise.resolve(true));
const preconnectDraft = vi.fn(() => Promise.resolve(true));
const drafts = new Set<string>();
vi.mock("./tcserver/commands", () => ({
  preconnect: (...args: unknown[]) => preconnect(...(args as [])),
  preconnectDraft: (...args: unknown[]) => preconnectDraft(...(args as [])),
}));
vi.mock("./tcserver/store", () => ({ sessionStore: { isDraft: (id: string) => drafts.has(id) } }));

const { askOnGesture, askPreconnect, idleForPreconnect, resetPreconnectAsks, ASK_EVERY_MS } = await import("./preconnect");

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

describe("askOnGesture", () => {
  afterEach(() => {
    resetPreconnectAsks();
    preconnect.mockClear();
    preconnectDraft.mockClear();
    drafts.clear();
  });
  const thread = { id: "s1", environmentId: "env-a", status: "idle" as const, harness: "claude" as const, model: "claude-haiku-5-5", projectId: "p1" };

  it("a thread's gesture asks its host to boot, once per half minute", () => {
    expect(askOnGesture(thread, 1_000)).toBe(true);
    expect(askOnGesture(thread, 2_000)).toBe(false);
    expect(preconnect).toHaveBeenCalledWith("s1", { boot: true });
    expect(askOnGesture(thread, 1_000 + ASK_EVERY_MS)).toBe(true);
    expect(preconnect).toHaveBeenCalledTimes(2);
  });

  it("a tab's socket-only ask does not swallow the gesture's boot", () => {
    expect(askPreconnect("s1", 1_000)).toBe(true);
    expect(askOnGesture(thread, 1_100)).toBe(true);
    expect(preconnect).toHaveBeenNthCalledWith(1, "s1");
    expect(preconnect).toHaveBeenNthCalledWith(2, "s1", { boot: true });
  });

  it("a thread mid-turn asks nothing", () => {
    expect(askOnGesture({ ...thread, status: "running" }, 1_000)).toBe(false);
    expect(preconnect).not.toHaveBeenCalled();
  });

  it("an unsent draft asks with its project and model, never boots, and needs a project", () => {
    drafts.add("d1");
    const draft = { ...thread, id: "d1" };
    expect(askOnGesture(draft, 1_000)).toBe(true);
    expect(preconnectDraft).toHaveBeenCalledWith("env-a", { provider: "claude", model: "claude-haiku-5-5", projectId: "p1" });
    expect(askOnGesture(draft, 2_000)).toBe(false);
    drafts.add("d2");
    expect(askOnGesture({ ...draft, id: "d2", projectId: undefined }, 3_000)).toBe(false);
    expect(preconnect).not.toHaveBeenCalled();
  });
});
