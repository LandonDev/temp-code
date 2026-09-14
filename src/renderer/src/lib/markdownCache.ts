/**
 * Markdown parse cache for settled blocks, hooked into streamdown's own
 * unified pipeline so the markup stays byte-for-byte what a fresh parse
 * would give.
 *
 * Streamdown runs `processor.runSync(processor.parse(text), text)` per
 * markdown block. Two plugins bracket that run:
 *
 *   cachedParse   — a remark plugin that wraps the parser: when the hast
 *                   for this text is cached it returns an empty mdast root,
 *                   so every transformer after it walks nothing.
 *   restoreHast   — the last rehype plugin: on a hit it swaps the empty
 *                   tree for the cached hast; on a miss it stores the tree
 *                   the pipeline just built.
 *
 * Both key on the block's text (the vfile is built from that same string).
 * Streaming blocks use the plain plugin lists and never touch the cache;
 * only a settled AgentMarkdown passes these in. The cache is bounded by
 * the RenderCache limits below (chars of markdown source).
 */
import type { Root as HastRoot } from "hast";
import type { Root as MdastRoot } from "mdast";
import type { Plugin } from "unified";
import { RenderCache } from "./renderCache";

export const hastCache = new RenderCache<HastRoot>(4000, 6_000_000);

/** Parses that reached the real parser — a test asserts a remount adds none. */
export const parseStats = { parses: 0 };

const emptyRoot = (): MdastRoot => ({ type: "root", children: [] });

export const cachedParse: Plugin<[], string, MdastRoot> = function () {
  const inner = this.parser;
  if (!inner) return;
  this.parser = (doc, file) => {
    if (hastCache.has(doc)) return emptyRoot();
    parseStats.parses++;
    return inner(doc, file) as MdastRoot;
  };
};

export const restoreHast: Plugin<[], HastRoot, HastRoot> = function () {
  return (tree, file) => {
    const text = String(file);
    const hit = hastCache.get(text);
    if (hit) return hit;
    hastCache.set(text, tree, text.length);
    return undefined;
  };
};
