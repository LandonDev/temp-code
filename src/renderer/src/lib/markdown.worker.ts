/**
 * Markdown parsing off the main thread: the renderer posts { id, text }
 * and gets back { id, blocks: [{ text, hast }] }, one entry per streamdown
 * block, for the hast cache. Results are kept here by digest too, so a
 * row asked for again (a remount after the cache evicted it) is a lookup.
 */
import { digestOf, parseMarkdownBlocks, type ParsedBlock } from "./markdownPipeline";
import { RenderCache } from "./renderCache";

const done = new RenderCache<ParsedBlock[]>(4000, 6_000_000);

self.onmessage = (e: MessageEvent<{ id: number; text: string }>) => {
  const { id, text } = e.data;
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
  self.postMessage({ id, blocks });
};
