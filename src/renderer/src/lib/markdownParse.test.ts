/**
 * The parse worker's client against a fake Worker: one request per digest
 * however many rows ask, the cache filled from the answer, readiness per
 * digest, and the no-worker fallback where everything is ready at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hastCache } from "./markdownCache";
import { digestOf, parseMarkdownBlocks, splitMarkdown } from "./markdownPipeline";
import {
  PARSE_READY_MAX,
  PARSE_REQUEST_MS,
  PARSE_WORKER_FIRST_ANSWER_MS,
  hasParseWorker,
  markdownReady,
  parseWorkerStats,
  prepareMarkdown,
  resetMarkdownParse,
  watchMarkdown,
} from "./markdownParse";
import { createWorkerQueue } from "./markdownWorkerQueue";

type Message = { id: number; text: string } | { cancel: number };
const posted: Message[] = [];
const texts = () => posted.flatMap((m) => ("text" in m ? [m] : []));

/** A Worker that parses on a timer, as the real one does off the thread. */
class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(_url: URL, _opts?: unknown) {}
  postMessage(msg: Message) {
    posted.push(msg);
    if (!("text" in msg)) return;
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
    await Promise.resolve();
    expect(posted.length).toBe(1);
    await a;
    expect(markdownReady(text)).toBe(true);
    expect(parseWorkerStats).toMatchObject({ requested: 1, answered: 1, failures: 0 });
    // Every block of the text is in the cache under its own text.
    const blocks = splitMarkdown(text);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const block of blocks) expect(hastCache.has(block)).toBe(true);
    // Asked again: nothing posted.
    await prepareMarkdown(text);
    expect(posted.length).toBe(1);
  });

  it("texts asked for in one task go to the worker the last asked first: the rows on screen before the overscan above", async () => {
    const texts = ["oldest, above the screen", "middle", "newest, at the bottom"];
    const all = Promise.all(texts.map((t) => prepareMarkdown(t)));
    expect(posted).toEqual([]);
    await Promise.resolve();
    expect(posted.map((m) => ("text" in m ? m.text : ""))).toEqual([...texts].reverse());
    await all;
    for (const t of texts) expect(markdownReady(t)).toBe(true);
  });

  it("different texts are different requests; the same text is one", async () => {
    await Promise.all([prepareMarkdown("alpha"), prepareMarkdown("beta"), prepareMarkdown("alpha")]);
    expect(texts().map((m) => m.text).sort()).toEqual(["alpha", "beta"]);
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
  it("late silence after a first answer falls back for that row only; the worker keeps serving the rest", async () => {
    vi.useFakeTimers();
    try {
      /** Answers everything but a text that says "silent". */
      class PickyWorker extends FakeWorker {
        override postMessage(msg: Message) {
          posted.push(msg);
          if (!("text" in msg) || msg.text.includes("silent")) return;
          setTimeout(() => this.onmessage?.({ data: { id: msg.id, blocks: parseMarkdownBlocks(msg.text) } }), 0);
        }
      }
      g.Worker = PickyWorker;
      const first = prepareMarkdown("first answer");
      await vi.advanceTimersByTimeAsync(1);
      await first;
      const silent = prepareMarkdown("a silent row");
      let silentDone = false;
      void silent.then(() => (silentDone = true));
      await vi.advanceTimersByTimeAsync(PARSE_REQUEST_MS - 10);
      expect(silentDone).toBe(false);
      expect(markdownReady("a silent row")).toBe(false);
      await vi.advanceTimersByTimeAsync(20);
      expect(silentDone).toBe(true);
      // That row parses on the main thread; the worker is still the worker.
      expect(markdownReady("a silent row")).toBe(true);
      expect(hasParseWorker()).toBe(true);
      expect(parseWorkerStats.failures).toBe(0);
      expect(parseWorkerStats.timeouts).toBe(1);
      const silentId = texts().find((m) => m.text === "a silent row")!.id;
      expect(posted).toContainEqual({ cancel: silentId });
      // The next row is still the worker's.
      const later = prepareMarkdown("a later row");
      await vi.advanceTimersByTimeAsync(1);
      await later;
      expect(markdownReady("a later row")).toBe(true);
      expect(parseWorkerStats.answered).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the deadline waits for the worker's first answer: a booting worker is the watchdog's call", async () => {
    vi.useFakeTimers();
    try {
      class SlowBoot extends FakeWorker {
        override postMessage(msg: Message) {
          posted.push(msg);
          if (!("text" in msg)) return;
          setTimeout(() => this.onmessage?.({ data: { id: msg.id, blocks: parseMarkdownBlocks(msg.text) } }), 3000);
        }
      }
      g.Worker = SlowBoot;
      const waiting = prepareMarkdown("alpha");
      await vi.advanceTimersByTimeAsync(3001);
      await waiting;
      expect(parseWorkerStats.timeouts).toBe(0);
      expect(parseWorkerStats.answered).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a fast switch cancels before posting: a row that leaves in the same task never reaches the worker", async () => {
    let done = false;
    const leave = watchMarkdown("a row passed through", () => (done = true));
    leave();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(posted).toEqual([]);
    expect(done).toBe(false);
    expect(parseWorkerStats.cancelled).toBe(1);
  });

  it("a row that leaves after posting sends a cancel; a second row on the same text keeps it alive", async () => {
    class Holding extends FakeWorker {
      override postMessage(msg: Message) {
        posted.push(msg);
      }
    }
    g.Worker = Holding;
    const leaveA = watchMarkdown("shared", () => {});
    const leaveB = watchMarkdown("shared", () => {});
    await Promise.resolve();
    expect(texts().length).toBe(1);
    leaveA();
    expect(posted.some((m) => "cancel" in m)).toBe(false);
    leaveB();
    expect(posted).toContainEqual({ cancel: texts()[0].id });
  });

  it("the worker skips a cancelled id and answers the rest", () => {
    const answers: number[] = [];
    const tasks: (() => void)[] = [];
    const parsed: string[] = [];
    const queue = createWorkerQueue({
      parse: (text) => {
        parsed.push(text);
        return text.length;
      },
      post: (a) => answers.push(a.id),
      schedule: (fn) => tasks.push(fn),
    });
    queue.receive({ id: 1, text: "one" });
    queue.receive({ id: 2, text: "two" });
    queue.receive({ id: 3, text: "three" });
    // The cancel lands before the queue's next task runs.
    queue.receive({ cancel: 2 });
    while (tasks.length) tasks.shift()!();
    expect(answers).toEqual([1, 3]);
    expect(parsed).toEqual(["one", "three"]);
    // A cancel for an id already answered is ignored, and leaves nothing behind.
    queue.receive({ cancel: 1 });
    queue.receive({ id: 4, text: "four" });
    while (tasks.length) tasks.shift()!();
    expect(answers).toEqual([1, 3, 4]);
  });

  it("a tree the hast cache evicted is asked for again instead of parsed on the main thread", async () => {
    const text = "## Evicted\n\nbody";
    await prepareMarkdown(text);
    expect(markdownReady(text)).toBe(true);
    hastCache.clear();
    expect(markdownReady(text)).toBe(false);
    await prepareMarkdown(text);
    expect(texts().filter((m) => m.text === text).length).toBe(2);
    expect(markdownReady(text)).toBe(true);
  });

  it("the ready set is bounded: the oldest digest is forgotten and its row asks again", async () => {
    /** Answers at once with no blocks: the bound alone decides readiness. */
    class Cheap extends FakeWorker {
      override postMessage(msg: Message) {
        posted.push(msg);
        if ("text" in msg) queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, blocks: [] } }));
      }
    }
    g.Worker = Cheap;
    const all = Array.from({ length: PARSE_READY_MAX + 1 }, (_, i) => `text ${i}`);
    // One at a time, so the answers land in this order.
    for (const t of all) await prepareMarkdown(t);
    expect(markdownReady(all[PARSE_READY_MAX])).toBe(true);
    expect(markdownReady(all[1])).toBe(true);
    expect(markdownReady(all[0])).toBe(false);
    const before = texts().length;
    await prepareMarkdown(all[0]);
    expect(texts().length).toBe(before + 1);
    expect(markdownReady(all[0])).toBe(true);
  });
});
