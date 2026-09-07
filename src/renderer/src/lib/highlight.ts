/**
 * Promise-based client for the shiki worker (ported from temp-code), with a
 * small result cache so a re-rendered block never crosses the thread twice.
 */

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (html: string | null) => void>();
const cache = new Map<string, string>();
const CACHE_CAP = 500;

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

export function highlight(code: string, lang: string): Promise<string | null> {
  const key = `${lang} ${code}`;
  const cached = cache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, (html) => {
      if (html) {
        if (cache.size >= CACHE_CAP) cache.clear();
        cache.set(key, html);
      }
      resolve(html);
    });
    getWorker().postMessage({ id, code, lang });
  });
}
