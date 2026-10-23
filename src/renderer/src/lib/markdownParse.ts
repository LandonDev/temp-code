/**
 * Client of the markdown parse worker (markdown.worker.ts). A settled row
 * asks `prepareMarkdown(text)` once; the answer lands in the hast cache
 * (lib/markdownCache.ts) under each block's text, and the row's digest is
 * marked ready, so the main thread mounts the parsed tree and never runs
 * the parser for it. Requests in flight are shared by digest. Where there
 * is no Worker (tests, a plain node renderer) every text is ready at once
 * and the main thread parses as it always did.
 */
import { useEffect, useMemo, useReducer } from "react";
import { hastCache } from "./markdownCache";
import { digestOf, type ParsedBlock } from "./markdownPipeline";

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (blocks: ParsedBlock[]) => void>();
const inflight = new Map<string, Promise<void>>();
/** Texts asked for in this task, posted together at its end. */
let queued: { id: number; text: string }[] = [];
const ready = new Set<string>();
/** The worker failed to load, threw, or never answered: the main thread
 *  parses from here on, and every row waiting on it renders at once. */
let broken = false;
let answered = false;
let watchdog: ReturnType<typeof setTimeout> | null = null;
/** How long the first answer may take (the worker's bundle loading and
 *  the first parse) before the worker is given up on. */
const FIRST_ANSWER_MS = 8000;

/** What the tests count: parses the worker answered, and texts handed to it. */
export const parseWorkerStats = { requested: 0, answered: 0, failures: 0 };

export function hasParseWorker(): boolean {
  return !broken && typeof Worker === "function";
}

/** Give the worker up: pending rows render on the main thread. */
function giveUp(): void {
  if (broken) return;
  broken = true;
  parseWorkerStats.failures++;
  if (watchdog) clearTimeout(watchdog);
  watchdog = null;
  worker?.terminate();
  worker = null;
  const waiting = [...pending.values()];
  pending.clear();
  inflight.clear();
  for (const fn of waiting) fn([]);
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./markdown.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; blocks: ParsedBlock[] }>) => {
      if (!answered) {
        answered = true;
        if (watchdog) clearTimeout(watchdog);
        watchdog = null;
      }
      const fn = pending.get(e.data.id);
      pending.delete(e.data.id);
      fn?.(e.data.blocks);
    };
    worker.onerror = giveUp;
    if (!answered && !watchdog) watchdog = setTimeout(giveUp, FIRST_ANSWER_MS);
  }
  return worker;
}

/**
 * Post what this task asked for, the last asked first. Rows ask in mount
 * order, top to bottom, and a thread opens at its bottom: the newest rows,
 * the ones on screen, parse before the screen of overscan above them.
 */
function flushQueued(): void {
  const batch = queued;
  queued = [];
  if (broken) return;
  const target = getWorker();
  for (let i = batch.length - 1; i >= 0; i--) target.postMessage(batch[i]);
}

/** Whether a text's tree is in the cache from the worker, or needs no worker. */
export function markdownReady(text: string): boolean {
  return !hasParseWorker() || ready.has(digestOf(text));
}

/** Parse `text` off the main thread and fill the cache; resolves once it
 *  is ready (at once when it already is, or there is no worker). */
export function prepareMarkdown(text: string): Promise<void> {
  if (!hasParseWorker()) return Promise.resolve();
  const key = digestOf(text);
  if (ready.has(key)) return Promise.resolve();
  const running = inflight.get(key);
  if (running) return running;
  const promise = new Promise<void>((resolve) => {
    const id = nextId++;
    parseWorkerStats.requested++;
    pending.set(id, (blocks) => {
      for (const block of blocks) hastCache.set(block.text, block.hast, block.text.length);
      if (!broken) {
        ready.add(key);
        parseWorkerStats.answered++;
      }
      inflight.delete(key);
      resolve();
    });
    if (queued.length === 0) queueMicrotask(flushQueued);
    queued.push({ id, text });
  });
  inflight.set(key, promise);
  return promise;
}

/** For tests: forget what was prepared. */
export function resetMarkdownParse(): void {
  ready.clear();
  inflight.clear();
  pending.clear();
  queued = [];
  parseWorkerStats.requested = 0;
  parseWorkerStats.answered = 0;
  parseWorkerStats.failures = 0;
  if (watchdog) clearTimeout(watchdog);
  watchdog = null;
  broken = false;
  answered = false;
  worker?.terminate();
  worker = null;
}

/** For tests: the first-answer deadline. */
export const PARSE_WORKER_FIRST_ANSWER_MS = FIRST_ANSWER_MS;

/**
 * Whether a settled row may mount its parsed tree yet. Not wanted (a
 * streaming row) is always ready; otherwise the worker is asked and the
 * row re-renders when the tree is in.
 */
export function useMarkdownReady(text: string, wanted: boolean): boolean {
  const key = useMemo(() => (wanted ? digestOf(text) : ""), [text, wanted]);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const isReady = !wanted || !hasParseWorker() || ready.has(key);
  useEffect(() => {
    if (!wanted || isReady) return;
    let live = true;
    void prepareMarkdown(text).then(() => {
      if (live) rerender();
    });
    return () => {
      live = false;
    };
    // The digest stands for the text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, wanted, isReady]);
  return isReady;
}
