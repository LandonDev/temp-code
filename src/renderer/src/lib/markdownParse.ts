/**
 * Client of the markdown parse worker (markdown.worker.ts). A settled row
 * asks `prepareMarkdown(text)` once; the answer lands in the hast cache
 * (lib/markdownCache.ts) under each block's text, and the row's digest is
 * marked ready, so the main thread mounts the parsed tree and never runs
 * the parser for it. Requests in flight are shared by digest. Where there
 * is no Worker (tests, a plain node renderer) every text is ready at once
 * and the main thread parses as it always did.
 *
 * Three bounds keep one slow or forgotten row from holding the rest:
 * - every request has a deadline (`REQUEST_MS`, counted once the worker has
 *   answered at all): past it that row alone gives up on the worker and
 *   parses on the main thread, while the worker keeps serving the others;
 * - a row that unmounts before its answer cancels its request (dropped
 *   before it is posted, else a `{ cancel: id }` the worker honours before
 *   parsing), so a thread passed through on the way to another never
 *   queues ahead of the one on screen;
 * - `ready` is an LRU of `READY_MAX` digests, each with the block texts its
 *   answer filled, and a digest is ready only while those trees are still
 *   in the hast cache: an evicted tree is asked for again (the worker's own
 *   cache answers it) instead of parsed on the main thread.
 */
import { useEffect, useMemo, useReducer, useRef } from "react";
import { hastCache } from "./markdownCache";
import { digestOf, type ParsedBlock } from "./markdownPipeline";

interface Request {
  id: number;
  key: string;
  text: string;
  promise: Promise<void>;
  resolve: () => void;
  /** Rows waiting on it; the last to leave cancels it. */
  waiters: number;
  timer: ReturnType<typeof setTimeout> | null;
}

let worker: Worker | null = null;
let nextId = 1;
/** Unanswered requests by id, and the same by digest. */
const pending = new Map<number, Request>();
const inflight = new Map<string, Request>();
/** Requests asked for in this task, posted together at its end. */
let queued: Request[] = [];
/** Digests the worker answered, oldest first, with the block texts they filled. */
const ready = new Map<string, string[]>();
/** Digests whose row gave up on the worker this time: they parse on the main thread. */
const fellBack = new Set<string>();
/** The worker failed to load, threw, or never answered: the main thread
 *  parses from here on, and every row waiting on it renders at once. */
let broken = false;
let answered = false;
let watchdog: ReturnType<typeof setTimeout> | null = null;
/** How long the first answer may take (the worker's bundle loading and
 *  the first parse) before the worker is given up on. */
const FIRST_ANSWER_MS = 8000;
/** How long one request may wait once the worker is up before its row
 *  parses on the main thread instead. */
const REQUEST_MS = 1500;
/** The hast cache's entry count: more ready digests than trees is a lie. */
const READY_MAX = 4000;

/** What the tests count: parses the worker answered, and texts handed to it. */
export const parseWorkerStats = { requested: 0, answered: 0, failures: 0, timeouts: 0, cancelled: 0 };

export function hasParseWorker(): boolean {
  return !broken && typeof Worker === "function";
}

function settle(req: Request): void {
  if (req.timer) clearTimeout(req.timer);
  req.timer = null;
  pending.delete(req.id);
  if (inflight.get(req.key) === req) inflight.delete(req.key);
  req.resolve();
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
  queued = [];
  for (const req of waiting) settle(req);
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./markdown.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id?: number; blocks?: ParsedBlock[] }>) => {
      // Any message proves the worker up, its boot line included: a cancelled
      // request is never answered, so answers alone cannot.
      if (!answered) {
        answered = true;
        if (watchdog) clearTimeout(watchdog);
        watchdog = null;
      }
      if (e.data.id === undefined) return;
      const req = pending.get(e.data.id);
      if (!req) return;
      const texts: string[] = [];
      for (const block of e.data.blocks ?? []) {
        hastCache.set(block.text, block.hast, block.text.length);
        texts.push(block.text);
      }
      if (!broken) {
        markReady(req.key, texts);
        parseWorkerStats.answered++;
      }
      settle(req);
    };
    worker.onerror = giveUp;
  }
  if (!answered && !watchdog) {
    watchdog = setTimeout(() => {
      watchdog = null;
      if (pending.size > 0) giveUp();
    }, FIRST_ANSWER_MS);
  }
  return worker;
}

function markReady(key: string, texts: string[]): void {
  ready.delete(key);
  ready.set(key, texts);
  fellBack.delete(key);
  while (ready.size > READY_MAX) ready.delete(ready.keys().next().value as string);
}

/** Ready while every tree its answer filled is still cached; else forgotten. */
function isReadyKey(key: string): boolean {
  const texts = ready.get(key);
  if (!texts) return false;
  for (const t of texts) {
    if (!hastCache.has(t)) {
      ready.delete(key);
      return false;
    }
  }
  return true;
}

/**
 * The request's deadline. Before the worker's first answer the first-answer
 * watchdog decides for everyone (the bundle is still loading), so the
 * deadline waits for it.
 */
function armDeadline(req: Request): void {
  req.timer = setTimeout(() => {
    req.timer = null;
    if (!pending.has(req.id)) return;
    if (!answered) {
      armDeadline(req);
      return;
    }
    parseWorkerStats.timeouts++;
    fellBack.add(req.key);
    if (fellBack.size > READY_MAX) fellBack.delete(fellBack.values().next().value as string);
    worker?.postMessage({ cancel: req.id });
    settle(req);
  }, REQUEST_MS);
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
  for (let i = batch.length - 1; i >= 0; i--) {
    const req = batch[i];
    target.postMessage({ id: req.id, text: req.text });
    armDeadline(req);
  }
}

/** Whether a text's tree is in the cache from the worker, or needs no worker. */
export function markdownReady(text: string): boolean {
  if (!hasParseWorker()) return true;
  const key = digestOf(text);
  return isReadyKey(key) || fellBack.has(key);
}

function request(text: string): Request | null {
  if (!hasParseWorker()) return null;
  const key = digestOf(text);
  if (isReadyKey(key) || fellBack.has(key)) return null;
  const running = inflight.get(key);
  if (running) {
    running.waiters++;
    return running;
  }
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  const req: Request = { id: nextId++, key, text, promise, resolve, waiters: 1, timer: null };
  parseWorkerStats.requested++;
  pending.set(req.id, req);
  inflight.set(key, req);
  if (queued.length === 0) queueMicrotask(flushQueued);
  queued.push(req);
  return req;
}

/** A row leaves: the last waiter on an unanswered request cancels it. */
function release(req: Request): void {
  if (--req.waiters > 0 || !pending.has(req.id)) return;
  parseWorkerStats.cancelled++;
  const at = queued.indexOf(req);
  if (at >= 0) queued.splice(at, 1);
  else worker?.postMessage({ cancel: req.id });
  settle(req);
}

/** Parse `text` off the main thread and fill the cache; resolves once it
 *  is ready (at once when it already is, or there is no worker), or when
 *  its row gave up on the worker. */
export function prepareMarkdown(text: string): Promise<void> {
  return request(text)?.promise ?? Promise.resolve();
}

/** For tests: forget what was prepared. */
export function resetMarkdownParse(): void {
  for (const req of pending.values()) if (req.timer) clearTimeout(req.timer);
  ready.clear();
  fellBack.clear();
  inflight.clear();
  pending.clear();
  queued = [];
  parseWorkerStats.requested = 0;
  parseWorkerStats.answered = 0;
  parseWorkerStats.failures = 0;
  parseWorkerStats.timeouts = 0;
  parseWorkerStats.cancelled = 0;
  if (watchdog) clearTimeout(watchdog);
  watchdog = null;
  broken = false;
  answered = false;
  worker?.terminate();
  worker = null;
}

/** For tests: the deadlines and the ready set's bound. */
export const PARSE_WORKER_FIRST_ANSWER_MS = FIRST_ANSWER_MS;
export const PARSE_REQUEST_MS = REQUEST_MS;
export const PARSE_READY_MAX = READY_MAX;

/**
 * Ask for `text` on behalf of one row: `onDone` runs once it is ready or
 * its row gave up on the worker (at once, synchronously, if nothing needs
 * asking). The returned function is the row leaving: the last row waiting
 * on an unanswered request cancels it.
 */
export function watchMarkdown(text: string, onDone: () => void): () => void {
  const req = request(text);
  if (!req) {
    onDone();
    return () => {};
  }
  let live = true;
  void req.promise.then(() => {
    if (live) onDone();
  });
  return () => {
    if (!live) return;
    live = false;
    release(req);
  };
}

/**
 * Whether a settled row may mount its parsed tree yet. Not wanted (a
 * streaming row) is always ready; otherwise the worker is asked and the
 * row re-renders when the tree is in, or when it gave up on the worker.
 * Once a row has mounted its tree it keeps it: an eviction later never
 * takes a row on screen back down.
 */
export function useMarkdownReady(text: string, wanted: boolean): boolean {
  const key = useMemo(() => (wanted ? digestOf(text) : ""), [text, wanted]);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const shown = useRef<string | null>(null);
  const isReady = !wanted || !hasParseWorker() || shown.current === key || isReadyKey(key) || fellBack.has(key);
  if (isReady && wanted) shown.current = key;
  useEffect(() => {
    if (!wanted || isReady) return;
    return watchMarkdown(text, rerender);
    // The digest stands for the text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, wanted, isReady]);
  return isReady;
}
