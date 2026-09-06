import type { Block, ToolPreviewLine } from "../session";
import type { LiveEditState } from "../tcserver/store";

/**
 * Pure selectors for the implementation board: which blocks belong to
 * which task, how long a pass really worked, and the change a task made
 * to a file as one card.
 */

/** Working time across a block sequence. Tool calls count their full run
 *  (ts → doneTs); the idle gap BEFORE a user message never counts — that
 *  is the user thinking between a halt and a resume, not the pass working. */
export function activeMs(list: Block[], liveNow?: number): number {
  let total = 0;
  let prev: number | undefined;
  for (const b of list) {
    if (b.ts === undefined) continue;
    if (prev !== undefined && b.role !== "user") total += Math.max(0, b.ts - prev);
    const end = b.role === "tool" ? (b.doneTs ?? b.ts) : b.ts;
    prev = Math.max(prev ?? end, end);
  }
  if (liveNow !== undefined && prev !== undefined) total += Math.max(0, liveNow - prev);
  return total;
}

/** File blocks under the task in progress at their birth; -1 = before the
 *  round's first list. Indices past a shrunken list clamp to the last. */
export function groupByTodo(list: Block[], todoCount: number): Map<number, Block[]> {
  const m = new Map<number, Block[]>();
  for (const b of list) {
    const todo = b.todo ?? -1;
    const k = todoCount === 0 ? -1 : todo < 0 ? -1 : Math.min(todo, todoCount - 1);
    const arr = m.get(k);
    if (arr) arr.push(b);
    else m.set(k, [b]);
  }
  return m;
}

export const ACT_KINDS: [RegExp, string, string][] = [
  [/^(Read|Glob|NotebookRead|fs\.read)$/i, "read", "files read"],
  [/^Grep$/i, "search", "searches"],
  [/^(Bash|shell)$/i, "command", "commands"],
  [/spawn_agent|wait_for_agent|check_agent|send_to_agent|answer_agent|list_agents/i, "subagent", "subagent calls"],
  [/^(WebSearch|web_search|WebFetch)$/i, "web", "web lookups"],
];

/** A tool block's activity family: edit, read, search, command, subagent, web, or tool. */
export function actKind(block: Block): string {
  const name = block.tool?.name ?? "";
  const kind = block.tool?.kind;
  if (kind === "edit") return "edit";
  for (const [re, k] of ACT_KINDS) if (re.test(name)) return k;
  if (kind === "read") return "read";
  if (kind === "search") return "search";
  if (kind === "execute") return "command";
  return "tool";
}

/** The file an edit block touched, when it names one. */
export function editPath(block: Block): string | undefined {
  if (block.role !== "tool" || block.tool?.kind !== "edit") return undefined;
  return block.tool.preview?.path;
}

/** Additions and deletions across a set of edit blocks. */
export function changeStat(blocks: Block[]): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const b of blocks) {
    if (!editPath(b)) continue;
    adds += b.tool?.preview?.additions ?? 0;
    dels += b.tool?.preview?.deletions ?? 0;
  }
  return { adds, dels };
}

/** The WHOLE change a task made to one file: a single edit as-is, several
 *  fused into one synthetic block whose hunks run in call order. */
export function wholeChange(path: string, edits: Block[]): Block {
  if (edits.length === 1) return edits[0];
  const first = edits[0];
  const last = edits[edits.length - 1];
  const lines = edits.flatMap((e) => e.tool?.preview?.lines ?? []);
  const additions = edits.reduce((n, e) => n + (e.tool?.preview?.additions ?? 0), 0);
  const deletions = edits.reduce((n, e) => n + (e.tool?.preview?.deletions ?? 0), 0);
  return {
    ...last,
    id: `${first.id}all`,
    text: `${edits.length} edits`,
    ts: first.ts,
    doneTs: last.doneTs,
    tool: {
      ...last.tool,
      callId: `${first.tool?.callId ?? first.id}#all`,
      name: "__merged__",
      preview: {
        kind: "write",
        path,
        additions,
        deletions,
        ...(lines.length > 0 ? { lines } : {}),
      },
    },
  };
}

/** Unified diff text as preview lines, uncapped. */
export function diffLines(diff: string): ToolPreviewLine[] {
  const out: ToolPreviewLine[] = [];
  let newNum = 0;
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) {
      newNum = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+")) {
      out.push({ number: newNum, kind: "add", text: line.slice(1) });
      newNum += 1;
    } else if (line.startsWith("-")) {
      out.push({ number: newNum, kind: "del", text: line.slice(1) });
    } else if (line.startsWith("\\")) {
      continue;
    } else if (line.length > 0 || out.length > 0) {
      out.push({ number: newNum, kind: "context", text: line.startsWith(" ") ? line.slice(1) : line });
      newNum += 1;
    }
  }
  while (out.length > 0 && out[out.length - 1].kind === "context" && !out[out.length - 1].text) out.pop();
  return out;
}

/** A shell-made change as a card the board can open. */
export function diskBlock(e: LiveEditState): Block {
  const lines = e.diff ? diffLines(e.diff) : [];
  return {
    id: `disk:${e.path}`,
    role: "tool",
    text: e.path,
    ts: e.startedTs,
    doneTs: e.ts,
    todo: -1,
    round: 0,
    tool: {
      callId: `disk:${e.path}`,
      name: "apply_patch",
      kind: "edit",
      status: "completed",
      detail: "via shell",
      preview: {
        kind: "write",
        path: e.path,
        additions: e.adds,
        deletions: e.dels,
        ...(lines.length > 0 ? { lines } : {}),
      },
    },
  };
}
