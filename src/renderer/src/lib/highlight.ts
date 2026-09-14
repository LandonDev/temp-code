/**
 * Promise-based client for the shiki worker (ported from temp-code). Results
 * live in a bounded render cache so a re-rendered or remounted block never
 * crosses the thread twice, and `highlightCached` lets a mount paint the
 * colouring synchronously when it is already known.
 */
import { RenderCache, cacheKey } from "./renderCache";

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (html: string | null) => void>();
const cache = new RenderCache<string>(2000, 4_000_000);

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; html: string | null }>) => {
      pending.get(e.data.id)?.(e.data.html);
      pending.delete(e.data.id);
    };
  }
  return worker;
}

/** The colouring if the worker already produced it; no work otherwise. */
export function highlightCached(code: string, lang: string): string | undefined {
  return cache.get(cacheKey(lang, code));
}

export function highlight(code: string, lang: string): Promise<string | null> {
  const key = cacheKey(lang, code);
  const cached = cache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, (html) => {
      if (html) cache.set(key, html, code.length);
      resolve(html);
    });
    getWorker().postMessage({ id, code, lang });
  });
}
