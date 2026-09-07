import type { Block } from "../lib/session";
import { isInternalPath } from "../lib/internalPath";
import { editModel } from "./editModel";

/**
 * An edit call, split for display: one standalone card per real file the
 * call touches (a multi-file patch never hides behind "+N more"), and the
 * app-bookkeeping remainder as one quiet block that reads as "Updated
 * project memory". Derived blocks keep the parent's status, approval and
 * streaming flag; each carries only its own file's change, so EditRow's
 * diff parsing and its by-path live edits work unchanged.
 */
export type EditCards = { cards: Block[]; internal: Block | null };

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Every file an edit call names. */
export function editPaths(block: Block): string[] {
  const m = editModel(block);
  return [m.path, ...m.extraPaths].filter(Boolean);
}

/** A copy of the call that stands for one part of it. */
function derive(block: Block, suffix: string, input: unknown): Block {
  const tool = block.tool ?? {};
  return {
    ...block,
    id: `${block.id}${suffix}`,
    tool: { ...tool, callId: `${tool.callId ?? block.id}#${suffix}`, input, preview: undefined },
  };
}

const FILE_HEADER = /^\*\*\* (Add|Delete|Update) File: (.+)$/;

/** Raw `*** Begin Patch` text → its per-file sections, in order. */
export function patchSections(text: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  let cur: { path: string; lines: string[] } | null = null;
  for (const line of text.split("\n")) {
    const m = FILE_HEADER.exec(line);
    if (m) {
      if (cur) out.push({ path: cur.path, text: cur.lines.join("\n") });
      cur = { path: m[2].trim(), lines: [line] };
      continue;
    }
    if (!cur || /^\*\*\* (Begin|End) Patch/.test(line)) continue;
    cur.lines.push(line);
  }
  if (cur) out.push({ path: cur.path, text: cur.lines.join("\n") });
  return out;
}

const wrap = (sections: string[]): string =>
  ["*** Begin Patch", ...sections, "*** End Patch"].join("\n");

/** The patch text and how to put a replacement back into the input. */
function patchText(block: Block): { text: string; rebuild: (t: string) => unknown } | null {
  const input = block.tool?.input;
  if (typeof input === "string") return { text: input, rebuild: (t) => t };
  const i = rec(input);
  for (const key of ["input", "patch"]) {
    if (typeof i[key] === "string") return { text: i[key], rebuild: (t) => ({ ...i, [key]: t }) };
  }
  return null;
}

const cache = new WeakMap<Block, EditCards>();

export function splitEditCards(block: Block): EditCards {
  const hit = cache.get(block);
  if (hit) return hit;
  const out = split(block);
  cache.set(block, out);
  return out;
}

function split(block: Block): EditCards {
  const input = block.tool?.input;
  if (block.tool?.name === "apply_patch") {
    if (Array.isArray(input)) {
      const changes = input.map(rec);
      if (changes.length > 1 || changes.some((c) => isInternalPath(str(c.path)))) {
        const real = changes.filter((c) => !isInternalPath(str(c.path)));
        const internal = changes.filter((c) => isInternalPath(str(c.path)));
        return {
          cards: real.map((c, n) => derive(block, `e${n}`, [c])),
          internal: internal.length ? derive(block, "m", internal) : null,
        };
      }
      return { cards: [block], internal: null };
    }
    const patch = patchText(block);
    if (patch) {
      const sections = patchSections(patch.text);
      if (sections.length > 1 || sections.some((s) => isInternalPath(s.path))) {
        const real = sections.filter((s) => !isInternalPath(s.path));
        const internal = sections.filter((s) => isInternalPath(s.path));
        return {
          cards: real.map((s, n) => derive(block, `e${n}`, patch.rebuild(wrap([s.text])))),
          internal: internal.length
            ? derive(block, "m", patch.rebuild(wrap(internal.map((s) => s.text))))
            : null,
        };
      }
      return { cards: [block], internal: null };
    }
  }
  const path = editModel(block).path;
  return path && isInternalPath(path) ? { cards: [], internal: block } : { cards: [block], internal: null };
}
