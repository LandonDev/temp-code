/**
 * The markdown pipeline, in one place so the parse worker (markdown.worker.ts)
 * and the main thread (surfaces/AgentMarkdown.tsx) build the same tree from
 * the same text: streamdown's own block split and remark → rehype chain
 * with the plugin lists the transcript renders with. A worker parse lands
 * in the hast cache keyed by block text, which is the key streamdown's
 * pipeline reads back through `restoreHast` (lib/markdownCache.ts), so the
 * markup is byte for byte what a main-thread parse would give.
 */
import type { Root as HastRoot } from "hast";
import { harden } from "rehype-harden";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import remend from "remend";
import { defaultRehypePlugins, defaultRemarkPlugins, parseMarkdownIntoBlocks } from "streamdown";
import { unified, type PluggableList } from "unified";

export const MARKDOWN_REHYPE_PLUGINS: PluggableList = [
  defaultRehypePlugins.raw,
  defaultRehypePlugins.sanitize,
  [
    harden,
    {
      allowedImagePrefixes: [] as string[],
      allowedLinkPrefixes: ["*"],
      allowDataImages: true,
      imageBlockPolicy: "remove" as const,
    },
  ],
];

export const MARKDOWN_REMARK_PLUGINS: PluggableList = Object.values(defaultRemarkPlugins);

/**
 * The blocks streamdown renders a text as: it closes what streaming left
 * open (remend) and splits on top-level markdown blocks. Each block is
 * parsed, memoised and cached on its own.
 */
export function splitMarkdown(text: string): string[] {
  return parseMarkdownIntoBlocks(remend(text));
}

type Processor = { parse: (doc: string) => unknown; runSync: (tree: unknown, file: string) => unknown };

let processor: Processor | null = null;

/** Streamdown's processor for these plugin lists: rehype-raw is in the
 *  chain, so no html-to-text step is added before remark-rehype. */
function parser(): Processor {
  if (!processor) {
    processor = unified()
      .use(remarkParse)
      .use(MARKDOWN_REMARK_PLUGINS)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(MARKDOWN_REHYPE_PLUGINS) as unknown as Processor;
  }
  return processor;
}

export type ParsedBlock = { text: string; hast: HastRoot };

/** Every block of `text` with its hast, ready for the cache. */
export function parseMarkdownBlocks(text: string): ParsedBlock[] {
  const p = parser();
  return splitMarkdown(text).map((block) => ({
    text: block,
    hast: p.runSync(p.parse(block), block) as HastRoot,
  }));
}

/**
 * A row's digest: FNV-1a over the text, twice with different seeds, plus
 * its length. What the worker's cache and the in-flight table key on; the
 * hast cache itself keys on the block text.
 */
export function digestOf(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 13);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}:${text.length}`;
}
