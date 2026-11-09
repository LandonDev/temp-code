import { parseShotLine } from "@shared/computer/tools";
import { computerToolOf } from "@shared/computer/words";
import type { Block } from "../lib/session";
import { inputOf } from "../lib/toolDetails";

/**
 * The pictures a completed computer call shows in the transcript: the
 * screenshots the model asked for (a `screenshot` or `zoom` step, or an
 * observation with `screenshot: true`), read off the result's shot lines
 * (docs/computer-protocol.md §9). A picture the service attached on its own
 * for a thin tree stays out. Blocks are replaced, never mutated, so the
 * answer is cached per block object.
 */

export interface ComputerShot {
  path: string;
  width: number;
  height: number;
  /** "Screenshot of TextEdit": the picture's accessible name and the lightbox's title */
  label: string;
}

const shortName = (name: string): string => name.replace(/^mcp__[^_]+(?:__)?/, "").replace(/^.*\./, "");

/** A computer call's own tool, whichever harness named it (`mcp__app__computer_act`, codex's `app.computer_act`). */
export function computerCallOf(block: Block): ReturnType<typeof computerToolOf> {
  return block.role === "tool" ? computerToolOf(shortName(block.tool?.name ?? "")) : null;
}

/** The result's text: claude stores the text parts joined (a picture as `[image]`), codex the MCP result as JSON. */
export function computerResultText(detail: string | undefined): string | null {
  if (!detail) return null;
  if (!detail.trimStart().startsWith("{")) return detail;
  try {
    const parsed = JSON.parse(detail) as { content?: unknown; structuredContent?: unknown };
    const parts = Array.isArray(parsed.content) ? parsed.content : [];
    const text = parts
      .filter((p): p is { type: "text"; text: string } => typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string")
      .map((p) => p.text)
      .join("\n");
    return text || detail;
  } catch {
    return detail;
  }
}

const APP_HEADER = /^app ("(?:[^"\\]|\\.)*")/m;

function appOf(text: string, input: Record<string, unknown>): string {
  const m = APP_HEADER.exec(text);
  if (m) {
    try {
      return JSON.parse(m[1]) as string;
    } catch {
      // fall through to the input's
    }
  }
  return typeof input.app === "string" && input.app.trim() ? input.app.trim() : "the app";
}

const cache = new WeakMap<Block, ComputerShot[]>();

export function computerShotsOf(block: Block): ComputerShot[] {
  const hit = cache.get(block);
  if (hit) return hit;
  const shots = parse(block);
  cache.set(block, shots);
  return shots;
}

function parse(block: Block): ComputerShot[] {
  if (block.tool?.status !== "completed" || !computerCallOf(block)) return [];
  const text = computerResultText(block.tool.detail);
  if (!text) return [];
  const input = inputOf(block);
  const asked = input.screenshot === true;
  const label = `Screenshot of ${appOf(text, input)}`;
  const shots: ComputerShot[] = [];
  for (const line of text.split("\n")) {
    const shot = parseShotLine(line);
    // A step's picture is a screenshot or zoom the model asked for; the observation's only when it asked.
    if (!shot || (shot.from === "observation" && !asked)) continue;
    shots.push({ path: shot.path, width: shot.width, height: shot.height, label });
  }
  return shots;
}

/** A completed computer call with a picture the model asked for: it stands as its own row where it settled. */
export function isComputerShotBlock(block: Block): boolean {
  return computerShotsOf(block).length > 0;
}
