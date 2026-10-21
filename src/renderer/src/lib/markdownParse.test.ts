/**
 * The parse worker's client against a fake Worker: one request per digest
 * however many rows ask, the cache filled from the answer, readiness per
 * digest, and the no-worker fallback where everything is ready at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hastCache } from "./markdownCache";
import { digestOf, parseMarkdownBlocks, splitMarkdown } from "./markdownPipeline";
import {
  PARSE_WORKER_FIRST_ANSWER_MS,
  markdownReady,
  parseWorkerStats,
  prepareMarkdown,
  resetMarkdownParse,
} from "./markdownParse";

type Message = { id: number; text: string };
const posted: Message[] = [];

/** A Worker that parses on a timer, as the real one does off the thread. */
class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(_url: URL, _opts?: unknown) {}
  postMessage(msg: Message) {
    posted.push(msg);
    setTimeout(() => {
      this.onmessage?.({ data: { id: msg.id, blocks: parseMarkdownBlocks(msg.text) } });
    }, 0);
  }
  terminate() {}
}

const g = globalThis as unknown as { Worker?: unknown };
const originalWorker = g.Worker;

describe("markdown parse worker client", () => {
  beforeEach(() => {
    posted.length = 0;
    hastCache.clear();
    resetMarkdownParse();
    g.Worker = FakeWorker;
  });
  afterEach(() => {
    resetMarkdownParse();
    g.Worker = originalWorker;
  });

  it("asks the worker once per digest and fills the cache from its answer", async () => {
    const text = "## Title\n\nA paragraph with **bold**.\n\n- one\n- two";
    expect(markdownReady(text)).toBe(false);
    const a = prepareMarkdown(text);
    const b = prepareMarkdown(text);
    expect(b).toBe(a);
    expect(posted.length).toBe(1);
    await a;
    expect(markdownReady(text)).toBe(true);
    expect(parseWorkerStats).toEqual({ requested: 1, answered: 1, failures: 0 });
    // Every block of the text is in the cache under its own text.
    const blocks = splitMarkdown(text);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const block of blocks) expect(hastCache.has(block)).toBe(true);
    // Asked again: nothing posted.
    await prepareMarkdown(text);
    expect(posted.length).toBe(1);
  });

  it("different texts are different requests; the same text is one", async () => {
    await Promise.all([prepareMarkdown("alpha"), prepareMarkdown("beta"), prepareMarkdown("alpha")]);
    expect(posted.map((m) => m.text)).toEqual(["alpha", "beta"]);
    expect(digestOf("alpha")).not.toBe(digestOf("beta"));
    expect(digestOf("alpha")).toBe(digestOf("alpha"));
  });

  it("a worker that errors is given up on: waiting rows render on the main thread", async () => {
    class BrokenWorker {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      constructor(_url: URL, _opts?: unknown) {}
      postMessage() {
        setTimeout(() => this.onerror?.(new Error("import failed")), 0);
      }
      terminate() {}
    }
    g.Worker = BrokenWorker;
    const a = prepareMarkdown("alpha");
    const b = prepareMarkdown("beta");
    expect(markdownReady("alpha")).toBe(false);
    await Promise.all([a, b]);
    // Nothing cached, but every text is ready: there is no worker any more.
    expect(hastCache.size).toBe(0);
    expect(markdownReady("alpha")).toBe(true);
    expect(markdownReady("gamma")).toBe(true);
    expect(parseWorkerStats.failures).toBe(1);
    await prepareMarkdown("gamma");
  });

  it("a worker that never answers is given up on after the first-answer deadline", async () => {
    vi.useFakeTimers();
    class SilentWorker {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      constructor(_url: URL, _opts?: unknown) {}
      postMessage() {}
      terminate() {}
    }
    g.Worker = SilentWorker;
    const waiting = prepareMarkdown("alpha");
    expect(markdownReady("alpha")).toBe(false);
    await vi.advanceTimersByTimeAsync(PARSE_WORKER_FIRST_ANSWER_MS + 1);
    await waiting;
    expect(markdownReady("alpha")).toBe(true);
    expect(parseWorkerStats.failures).toBe(1);
    vi.useRealTimers();
  });

  it("with no Worker, every text is ready and nothing is asked", async () => {
    g.Worker = undefined;
    expect(markdownReady("whatever")).toBe(true);
    await prepareMarkdown("whatever");
    expect(posted.length).toBe(0);
    expect(hastCache.size).toBe(0);
  });
});
