/**
 * Markdown parsing off the main thread: the renderer posts { id, text }
 * and gets back { id, blocks: [{ text, hast }] }, one entry per streamdown
 * block, for the hast cache; it may post { cancel: id } for a request it no
 * longer wants, which is skipped if not yet parsed (markdownWorkerQueue.ts).
 * Results are kept here by digest too, so a row asked for again (a remount
 * after the cache evicted it) is a lookup. One `{ boot: true }` line on load
 * tells the client the worker is up.
 */
import { digestOf, parseMarkdownBlocks, type ParsedBlock } from "./markdownPipeline";
import { createWorkerQueue, type WorkerMessage } from "./markdownWorkerQueue";
import { RenderCache } from "./renderCache";

const done = new RenderCache<ParsedBlock[]>(4000, 6_000_000);

function parse(text: string): ParsedBlock[] {
  const key = digestOf(text);
  let blocks = done.get(key);
  if (!blocks) {
    try {
      blocks = parseMarkdownBlocks(text);
    } catch {
      blocks = [];
    }
    done.set(key, blocks, text.length);
  }
  return blocks;
}

// A MessageChannel yields to the messages already waiting without the
// nested-timer clamp setTimeout would add per parse.
const yieldChannel = new MessageChannel();
let next: (() => void) | null = null;
yieldChannel.port1.onmessage = () => {
  const fn = next;
  next = null;
  fn?.();
};

const queue = createWorkerQueue({
  parse,
  post: (answer) => self.postMessage(answer),
  schedule: (fn) => {
    next = fn;
    yieldChannel.port2.postMessage(null);
  },
});

self.onmessage = (e: MessageEvent<WorkerMessage>) => queue.receive(e.data);
self.postMessage({ boot: true });
