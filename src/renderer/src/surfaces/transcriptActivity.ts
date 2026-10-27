import {
  composeToolTitle,
  isEditTool,
  isExecuteTool,
  isReadTool,
  isSearchTool,
  isWeakToolTitle,
} from "../lib/harness/preview";
import { displayPath } from "../lib/paths";
import type { Block } from "../lib/session";
import type { LiveEditState } from "../lib/tcserver/store";
import { groupPhrase } from "../lib/groupPhrase";
import { kindOf, toolPhrase } from "../lib/toolPhrase";
import { editModel, isEditBlock } from "./editModel";
import { splitEditCards } from "./editCards";
import { htmlRenderOf } from "./htmlRenderBlock";

export type ToolCallState = "pending" | "accepted" | "rejected";

export type TurnItem =
  { type: "block"; block: Block } | { type: "activity"; blocks: Block[] };

export function needsApproval(block: Block): boolean {
  return !!block.approval && !block.approval.decided;
}

/** A question card still waiting on the user (the turn has not moved on). */
export function needsAnswer(block: Block): boolean {
  return (
    !!block.question &&
    block.question.answers === undefined &&
    block.tool?.status === "running"
  );
}

/** Anything the turn cannot continue without: an approval or an answer. */
export function awaitsUser(block: Block): boolean {
  return needsApproval(block) || needsAnswer(block);
}

export function toolCallState(block: Block): ToolCallState {
  const status = block.tool?.status?.toLowerCase() ?? "";
  const decided = block.approval?.decided;

  if (decided === "deny") return "rejected";
  if (
    status === "failed" ||
    status === "error" ||
    status === "cancelled" ||
    status === "canceled"
  ) {
    return "rejected";
  }
  if (needsApproval(block)) return "pending";
  if (status === "completed" || status === "success") return "accepted";
  if (
    block.streaming ||
    status === "in_progress" ||
    status === "pending" ||
    status === "running"
  ) {
    return "pending";
  }
  if (decided === "allow" || !status) return "accepted";
  return "pending";
}

export function toolCallLabel(block: Block, cwd?: string): string {
  const phrase = toolPhrase(block, cwd);
  if (phrase) return phrase;
  const preview = block.tool?.preview;
  const path = preview?.path
    ? displayPath(preview.path, cwd)
    : preview?.fileName;
  return (
    composeToolTitle({
      kind: block.tool?.kind,
      title: block.text || block.tool?.title,
      path,
      query: preview?.query,
      previewKind: preview?.kind,
      cwd,
    }) || "Working"
  );
}

export function isIncompleteTool(
  block: Block,
  label: string,
  state: ToolCallState,
): boolean {
  if (state !== "pending") return false;
  const kind = block.tool?.kind?.toLowerCase();
  if (kind && kind !== "other") return false;
  if (
    block.tool?.preview?.path ||
    block.tool?.preview?.query ||
    block.tool?.preview?.lines?.length
  ) {
    return false;
  }
  return !label || isWeakToolTitle(label);
}

export function isHiddenTool(block: Block): boolean {
  if (block.role !== "tool" && block.role !== "approval") return false;
  if (
    isEditTool(
      block.tool?.kind,
      block.text || block.tool?.title,
      block.tool?.preview,
    )
  ) {
    return false;
  }
  const state = toolCallState(block);
  return isIncompleteTool(block, toolCallLabel(block), state);
}

/**
 * A step that folds into a run of actions: a call, or a thought. An edit
 * still awaiting approval stays out: you cannot judge a diff you cannot see.
 */
export function isActivityBlock(block: Block): boolean {
  if (isThinkingBlock(block)) return true;
  if (block.role !== "tool" && block.role !== "approval") return false;
  if (isHtmlRenderBlock(block)) return false;
  if (
    isEditTool(
      block.tool?.kind,
      block.text || block.tool?.title,
      block.tool?.preview,
    ) &&
    needsApproval(block)
  ) {
    return false;
  }
  return !isHiddenTool(block);
}

/** Reasoning the agent streams while it works: a step in the run it sits in. */
export function isThinkingBlock(block: Block): boolean {
  return block.role === "reasoning" && !!block.text.trim();
}

export function isToolBlock(block: Block): boolean {
  return block.role === "tool" || block.role === "approval";
}

/** Assistant prose with something in it — the paragraphs between tool calls. */
export function isProseBlock(block: Block): boolean {
  return block.role === "assistant" && !!block.text.trim();
}

/**
 * A block that hands the turn to the user: a question, answered or not, and
 * an approval still undecided. It renders full size where it sits, never
 * as a step inside a folded group, so what it asks stays readable.
 */
export function endsWork(block: Block): boolean {
  return block.question != null || needsApproval(block);
}

/** First paragraph of a folded prose block, stripped to one plain line. */
export function proseSummary(text: string): string {
  const body = text.replace(/```[\s\S]*?(?:```|$)/g, " ");
  const paragraph =
    body
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .find(Boolean) ?? "";
  return paragraph
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Canonical verb for a write-preview row, so edits read as "Edit src/app.ts"
 * alongside "Read" and "Find". Harnesses phrase these in past tense, hence the
 * doubled-up forms.
 */
export function editVerb(label: string): string {
  const word = label.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (/^(delete|deleted|remove|removed)$/.test(word)) return "Delete";
  if (/^(move|moved|rename|renamed)$/.test(word)) return "Move";
  if (/^(create|created|add|added|new)$/.test(word)) return "Create";
  if (/^(write|wrote|writing)$/.test(word)) return "Write";
  return "Edit";
}

/** User turns, with handoff dividers sitting on their own row. */
export function groupTurns(blocks: Block[]): Block[][] {
  const turns: Block[][] = [];
  let current: Block[] = [];
  for (const block of blocks) {
    if (block.role === "handoff") {
      if (current.length > 0) turns.push(current);
      turns.push([block]);
      current = [];
      continue;
    }
    if (block.role === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(block);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

/**
 * A turn's items: every paragraph stands full size where it streamed, and
 * everything between two paragraphs (calls, settled edits, thinking) folds
 * into one run. A question or an undecided approval breaks the run and
 * stands alone.
 */
export function groupTurnItems(blocks: Block[]): TurnItem[] {
  const visible = blocks.filter(
    (block, index) =>
      !isIgnoredTurnBlock(block) &&
      (isTodoBlock(block) || isHtmlRenderBlock(block) || !isHiddenTool(block)) &&
      !repeatsNextProse(blocks, index),
  );
  const items: TurnItem[] = [];
  let activity: Block[] = [];
  const flush = () => {
    if (activity.length > 0) {
      items.push({ type: "activity", blocks: activity });
    }
    activity = [];
  };
  for (const block of visible) {
    const folds =
      !isTodoBlock(block) &&
      !isHtmlRenderBlock(block) &&
      !endsWork(block) &&
      isActivityBlock(block);
    if (folds) {
      activity.push(block);
      continue;
    }
    flush();
    items.push({ type: "block", block });
  }
  flush();
  return items;
}

/** The agent's todo list stands as its own row where it was written. */
export function isTodoBlock(block: Block): boolean {
  return block.role === "tool" && kindOf(block) === "todo";
}

/**
 * A published HTML page stands as its own row where the call completed. A
 * running html_render still folds into the activity group, so the frame
 * mounts once, when its result lands, and nothing above it moves.
 */
export function isHtmlRenderBlock(block: Block): boolean {
  return htmlRenderOf(block) !== null;
}

/** Empty reasoning and empty prose (a stream's placeholder) take no row. */
function isIgnoredTurnBlock(block: Block): boolean {
  if (block.role === "reasoning") return !block.text.trim();
  return block.role === "assistant" && !block.text.trim();
}

/**
 * A thought the harness then says again as the next paragraph, word for
 * word. The paragraph shows it in full, so the dimmed step would only
 * repeat it.
 */
function repeatsNextProse(blocks: Block[], index: number): boolean {
  const block = blocks[index];
  if (block.role !== "reasoning") return false;
  const next = blocks
    .slice(index + 1)
    .find((b) => b.role !== "assistant" || b.text.trim());
  return (
    next?.role === "assistant" && plainText(next.text) === plainText(block.text)
  );
}

function plainText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Markdown the user actually reads: assistant prose plus any plan, not tool chrome. */
export function turnCopyText(blocks: Block[]): string {
  return blocks
    .filter((block) => block.role === "assistant" || block.role === "plan")
    .map((block) => block.text.replace(/\r\n?/g, "\n").trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * What a run of tool calls was for. Reads and searches are one thing — looking
 * around — so a grep followed by the file it turned up stays one group.
 */
export type ActivityWorkKind = "research" | "edit" | "run" | "other";

/** Ties break towards the kind that changed the most: an edit outranks a read. */
const WORK_KIND_ORDER: ActivityWorkKind[] = [
  "edit",
  "run",
  "research",
  "other",
];

export function toolCategory(block: Block): ActivityWorkKind {
  const kind = block.tool?.kind;
  const title = block.text || block.tool?.title;
  const preview = block.tool?.preview;
  if (isEditTool(kind, title, preview)) return "edit";
  if (isSearchTool(kind, title, preview)) return "research";
  if (isReadTool(kind, title, preview)) return "research";
  if (isExecuteTool(kind, title)) return "run";
  return "other";
}

function dominantWorkKind(steps: Block[]): ActivityWorkKind | undefined {
  const counts = new Map<ActivityWorkKind, number>();
  for (const block of steps) {
    if (!isToolBlock(block)) continue;
    const kind = toolCategory(block);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  let best: ActivityWorkKind | undefined;
  for (const kind of WORK_KIND_ORDER) {
    const count = counts.get(kind) ?? 0;
    if (count > 0 && (!best || count > (counts.get(best) ?? 0))) best = kind;
  }
  return best;
}

/** The glyph a run leads with: its dominant kind of work, or think. */
export type ActionGroupKind = ActivityWorkKind | "think";

/** What a run of actions adds up to, for its one line. */
export type ActionGroup = {
  kind: ActionGroupKind;
  phrase: string;
  /** Lines added and removed over every edit in the run. */
  adds: number;
  dels: number;
  /** Calls that failed or were denied. */
  failed: number;
  /**
   * At most one call (with any thoughts around it): no line and no box, the
   * steps draw as their own rows in order. A line over one call, or over a
   * thought, would only say the row again.
   */
  lone: boolean;
};

/** A running edit's server-side record, by the same suffix match EditRow uses. */
export function liveEditFor(
  path: string,
  liveEdits: Record<string, LiveEditState> | undefined,
): LiveEditState | undefined {
  if (!path || !liveEdits) return undefined;
  return (
    liveEdits[path] ??
    Object.values(liveEdits).find((r) => path.endsWith("/" + r.path) || r.path.endsWith("/" + path))
  );
}

export function actionGroupOf(
  blocks: Block[],
  { cwd, live = false, liveEdits }: { cwd?: string; live?: boolean; liveEdits?: Record<string, LiveEditState> } = {},
): ActionGroup {
  const tools = blocks.filter(isToolBlock);
  let adds = 0;
  let dels = 0;
  for (const block of tools) {
    if (!isEditBlock(block)) continue;
    const running = toolCallState(block) === "pending";
    for (const card of splitEditCards(block).cards) {
      const m = editModel(card);
      const rec = running ? liveEditFor(m.path, liveEdits) : undefined;
      adds += rec?.adds ?? m.adds;
      dels += rec?.dels ?? m.dels;
    }
  }
  const kind = dominantWorkKind(blocks) ?? "think";
  const phrase =
    kind === "think"
      ? live ? "Thinking" : "Thought"
      : groupPhrase(blocks, cwd, live) || (live ? "Working" : "Worked");
  return {
    kind,
    phrase,
    adds,
    dels,
    failed: tools.filter((b) => toolCallState(b) === "rejected").length,
    lone: tools.length <= 1,
  };
}

/** When a thought in a run settled: its own end, else the next step's start. */
export function thoughtEndTs(blocks: Block[], index: number): number | undefined {
  const block = blocks[index];
  if (block?.doneTs != null) return block.doneTs;
  return blocks.slice(index + 1).find((b) => b.ts != null)?.ts;
}
