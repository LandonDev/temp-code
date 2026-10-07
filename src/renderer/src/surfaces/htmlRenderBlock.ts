import {
  HTML_RENDER_TOOL_NAME,
  readHtmlRenderReference,
  type HtmlRenderReference,
} from "@shared/htmlRender";
import type { Block } from "../lib/session";

/**
 * A completed `html_render` call carries the page it published in its
 * result. The block then stands as its own row (the page itself) rather than
 * folding into the activity group. Blocks are replaced, never mutated, so the
 * parse is cached per block object.
 */

const cache = new WeakMap<Block, HtmlRenderReference | null>();

export function htmlRenderOf(block: Block): HtmlRenderReference | null {
  const hit = cache.get(block);
  if (hit !== undefined) return hit;
  const reference = parse(block);
  cache.set(block, reference);
  return reference;
}

const shortName = (name: string): string =>
  name.replace(/^mcp__[^_]+(?:__)?/, "").replace(/^.*\./, "");

function parse(block: Block): HtmlRenderReference | null {
  if (block.role !== "tool" || block.tool?.status !== "completed") return null;
  if (shortName(block.tool.name ?? "") !== HTML_RENDER_TOOL_NAME) return null;
  const detail = block.tool.detail;
  if (!detail) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return null;
  }
  return readHtmlRenderReference(unwrap(parsed)?.htmlRender) ?? null;
}

/** The result object, whichever envelope the harness stored it in. */
function unwrap(value: unknown): { htmlRender?: unknown } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if ("htmlRender" in record) return record;
  // Codex stores the MCP result: structuredContent or a text part holding the JSON.
  const structured = record.structuredContent;
  if (typeof structured === "object" && structured !== null && "htmlRender" in structured) {
    return structured as { htmlRender?: unknown };
  }
  if (Array.isArray(record.content)) {
    const part = record.content.find(
      (c): c is { type: "text"; text: string } =>
        typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text",
    );
    if (part && typeof part.text === "string") {
      try {
        return unwrap(JSON.parse(part.text));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
