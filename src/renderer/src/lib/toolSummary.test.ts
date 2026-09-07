import { beforeEach, describe, expect, it } from "vitest";
import type { Block } from "./session";
import {
  captionMapOf,
  fetchSummary,
  resetSummaryCacheForTest,
  summaryGroupSettled,
  summaryItemsFor,
  summaryKeyFor,
  summaryRequestFor,
  toolSettled,
  type SummaryLink,
} from "./toolSummary";

function tool(
  id: string,
  extra: Partial<Block["tool"]> & { streaming?: boolean; approval?: Block["approval"] } = {},
): Block {
  const { streaming, approval, ...toolExtra } = extra;
  return {
    id,
    role: approval ? "approval" : "tool",
    text: `Read ${id}`,
    streaming,
    approval,
    tool: { callId: `c-${id}`, name: "Read", kind: "read", status: "completed", detail: "ok", ...toolExtra },
  };
}

const WANT_BOTH = { sentence: true, captions: true };
const WANT_SENTENCE = { sentence: true, captions: false };

describe("toolSettled", () => {
  it("waits for streams, open statuses and undecided approvals", () => {
    expect(toolSettled(tool("a"))).toBe(true);
    expect(toolSettled(tool("a", { streaming: true }))).toBe(false);
    expect(toolSettled(tool("a", { status: "running" }))).toBe(false);
    expect(toolSettled(tool("a", { approval: { requestId: 1 } }))).toBe(false);
    expect(toolSettled(tool("a", { approval: { requestId: 1, decided: "deny" } }))).toBe(true);
  });
});

describe("summaryKeyFor", () => {
  it("is null while the group runs or any output is still open", () => {
    const tools = [tool("a"), tool("b")];
    expect(summaryKeyFor(tools, true, WANT_BOTH)).toBeNull();
    expect(summaryKeyFor([tool("a"), tool("b", { streaming: true })], false, WANT_BOTH)).toBeNull();
    expect(summaryGroupSettled([], false)).toBe(false);
  });

  it("keys a settled group by its first call, its size and what it wants", () => {
    const tools = [tool("a"), tool("b")];
    expect(summaryKeyFor(tools, false, WANT_BOTH)).toBe("c-a:2:c");
    expect(summaryKeyFor(tools, false, WANT_SENTENCE)).toBe("c-a:2:s");
  });

  it("does not ask for a sentence over a lone call", () => {
    expect(summaryKeyFor([tool("a")], false, WANT_SENTENCE)).toBeNull();
    expect(summaryKeyFor([tool("a")], false, WANT_BOTH)).toBe("c-a:1:c");
    expect(summaryKeyFor([tool("a"), tool("b")], false, { sentence: false, captions: false })).toBeNull();
  });

  it("ignores question cards and prose in the group", () => {
    const question: Block = {
      id: "q",
      role: "tool",
      text: "Ask",
      tool: { callId: "c-q", status: "running" },
      question: { requestId: "r", sessionId: "s", questions: [] } as unknown as Block["question"],
    };
    const prose: Block = { id: "p", role: "assistant" as Block["role"], text: "hi" };
    expect(summaryKeyFor([tool("a"), question, prose, tool("b")], false, WANT_SENTENCE)).toBe("c-a:2:s");
  });
});

describe("summaryItemsFor", () => {
  it("caps items and output length", () => {
    const many = Array.from({ length: 30 }, (_, i) => tool(`t${i}`, { detail: "x".repeat(500) }));
    const items = summaryItemsFor(many);
    expect(items).toHaveLength(24);
    expect(items[0].output).toHaveLength(220);
    expect(items[0]).toMatchObject({ name: "Read", detail: "Read t0" });
  });

  it("omits output for a call without one", () => {
    const denied = tool("a", { detail: undefined, approval: { requestId: 1, decided: "deny" } });
    expect(summaryItemsFor([denied])[0]).not.toHaveProperty("output");
  });
});

describe("fetchSummary", () => {
  beforeEach(() => resetSummaryCacheForTest());

  function fakeLink(answer: () => Promise<unknown>): SummaryLink & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      request<T>(method: string, params?: unknown): Promise<T> {
        calls.push({ method, params });
        return answer() as Promise<T>;
      },
    };
  }

  it("sends one request per key and reuses the answer", async () => {
    const link = fakeLink(() => Promise.resolve({ sentence: " Read two files. ", captions: ["a", ""] }));
    const tools = [tool("a"), tool("b")];
    const req = summaryRequestFor("s1", tools, "auto", true);
    expect(req).toMatchObject({ sessionId: "s1", groupKey: "c-a:2", model: "auto", captions: true });
    const [first, second] = await Promise.all([
      fetchSummary("k", "s1", tools, WANT_BOTH, "auto", link),
      fetchSummary("k", "s1", tools, WANT_BOTH, "auto", link),
    ]);
    expect(link.calls).toHaveLength(1);
    expect((link.calls[0] as { method: string }).method).toBe("tools.summarize");
    expect(first).toEqual({ sentence: "Read two files.", captions: ["a", null] });
    expect(second).toBe(first);
    await fetchSummary("k", "s1", tools, WANT_BOTH, "auto", link);
    expect(link.calls).toHaveLength(1);
  });

  it("caches a failure as empty so the group never retries", async () => {
    const link = fakeLink(() => Promise.reject(new Error("no")));
    const tools = [tool("a"), tool("b")];
    expect(await fetchSummary("k", "s1", tools, WANT_BOTH, "auto", link)).toEqual({ sentence: null, captions: [] });
    await fetchSummary("k", "s1", tools, WANT_BOTH, "auto", link);
    expect(link.calls).toHaveLength(1);
  });

  it("drops what the caller did not want", async () => {
    const link = fakeLink(() => Promise.resolve({ sentence: "S", captions: ["c"] }));
    const tools = [tool("a"), tool("b")];
    expect(await fetchSummary("k", "s1", tools, WANT_SENTENCE, "auto", link)).toEqual({ sentence: "S", captions: [] });
  });
});

describe("captionMapOf", () => {
  it("keys captions by call id and skips blanks", () => {
    const map = captionMapOf([tool("a"), tool("b"), tool("c")], { sentence: null, captions: ["One", null, "Three"] });
    expect(map.get("c-a")).toBe("One");
    expect(map.has("c-b")).toBe(false);
    expect(map.get("c-c")).toBe("Three");
  });
});
