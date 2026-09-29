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
import { groupPhrase, kindOf, toolPhrase } from "../lib/toolPhrase";

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
 * Zen mode folds edits in with the reads and searches. An edit still awaiting
 * approval stays out: you cannot judge a diff you cannot see.
 */
export function isActivityBlock(block: Block, zen = false): boolean {
  if (zen && isThinkingBlock(block)) return true;
  if (block.role !== "tool" && block.role !== "approval") return false;
  if (
    isEditTool(
      block.tool?.kind,
      block.text || block.tool?.title,
      block.tool?.preview,
    ) &&
    (!zen || needsApproval(block))
  ) {
    return false;
  }
  return !isHiddenTool(block);
}

/** Reasoning the agent streams while it works. Zen shows it, nothing else does. */
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
 * an approval still undecided. Zen renders it full size where it sits, never
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
 * Zen never folds what the agent said: every paragraph stands full size where
 * it streamed, and each run of tool calls between two paragraphs folds into
 * one activity group. Thinking rides inside the group it precedes.
 */
export function groupTurnItems(blocks: Block[], zen = false): TurnItem[] {
  const visible = blocks.filter(
    (block) =>
      !isIgnoredTurnBlock(block, zen) &&
      (isTodoBlock(block) || !isHiddenTool(block)),
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
      !(zen && endsWork(block)) &&
      isActivityBlock(block, zen);
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

function isIgnoredTurnBlock(block: Block, zen: boolean): boolean {
  // Zen keeps thinking as a step in the group, so a long think does not read
  // as the agent having stalled. Everywhere else it stays out of the transcript.
  if (block.role === "reasoning") return !zen || !block.text.trim();
  return block.role === "assistant" && !block.text.trim();
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
 * Rows for the live stack: the newest finished call holds the line, anything
 * waiting on you sits under it, and the rest waits behind the disclosure.
 */
export function splitActivityRows(blocks: Block[]): {
  latest?: Block;
  pending: Block[];
  hidden: Block[];
} {
  const pending = blocks.filter(awaitsUser);
  const completed = blocks.filter((block) => !awaitsUser(block));
  const latest = completed[completed.length - 1];
  return {
    latest,
    pending,
    hidden: latest ? completed.slice(0, -1) : [],
  };
}

/** The turn's last activity group: the one still live while the turn runs. */
export function lastActivityIndex(items: TurnItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].type === "activity") return index;
  }
  return -1;
}

export function activityPreviousLabel(count: number): string {
  return `+${count} previous ${count === 1 ? "tool call" : "tool calls"}`;
}

/**
 * What a run of tool calls was for. Reads and searches are one thing — looking
 * around — so a grep followed by the file it turned up stays one group.
 */
export type ActivityWorkKind = "research" | "edit" | "run" | "other";

/** A work kind, or a group the agent only thought in. */
export type ActivityPhaseKind = ActivityWorkKind | "think";

/**
 * One chunk of a turn: a run of calls of one kind, with the thinking that
 * led into them. The prose around a group never joins it; it stands full
 * size in the transcript, before and after.
 */
export type ActivityPhase = {
  id: string;
  kind: ActivityPhaseKind;
  steps: Block[];
};

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

/**
 * Splits a turn's activity into groups: one per kind of work, so a run of
 * reads followed by a run of edits reads as two things. Thinking is a step,
 * never a header, and a thought at the end of a group moves into the group
 * it introduced.
 */
export function buildActivityPhases(blocks: Block[]): ActivityPhase[] {
  const phases: ActivityPhase[] = [];
  let current: ActivityPhase | undefined;

  const open = (kind: ActivityPhaseKind) => {
    current = { id: "", kind, steps: [] };
    phases.push(current);
    return current;
  };

  for (const block of blocks) {
    if (isThinkingBlock(block)) {
      if (!current) current = open("think");
      current.steps.push(block);
      if (!current.id) current.id = block.id;
      continue;
    }
    const kind = toolCategory(block);
    if (!current) {
      current = open(kind);
    } else if (current.kind === "think") {
      // A group that opened on a thought takes the shape of the work after it.
      current.kind = kind;
    } else if (current.kind !== kind) {
      const trailing = takeTrailingNarration(current);
      current = open(kind);
      current.steps.push(...trailing);
      if (trailing[0]) current.id = trailing[0].id;
    }
    current.steps.push(block);
    if (!current.id) current.id = block.id;
  }

  return absorbStrayPhases(phases);
}

/** The run of thinking a group ends on, lifted out of it. */
function takeTrailingNarration(phase: ActivityPhase): Block[] {
  let cut = phase.steps.length;
  while (cut > 0 && !isToolBlock(phase.steps[cut - 1])) cut -= 1;
  return phase.steps.splice(cut);
}

/**
 * A single call of another kind — the read wedged between two edits, the test
 * run after them — folds back into the group before it rather than taking a
 * header of its own.
 */
function absorbStrayPhases(phases: ActivityPhase[]): ActivityPhase[] {
  const kept: ActivityPhase[] = [];
  for (const phase of phases) {
    const previous = kept[kept.length - 1];
    const stray = phase.steps.filter(isToolBlock).length === 1;
    if (previous && stray && previous.steps.length > 0) {
      previous.steps.push(...phase.steps);
      previous.kind = dominantWorkKind(previous.steps) ?? previous.kind;
      continue;
    }
    kept.push(phase);
  }
  return kept;
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

/**
 * The group's header: what the calls add up to in plain words — "Read 3 files
 * in src/lib · Searched for tokens" — in the present tense while the group is
 * still running. A group that only thought says so.
 */
export function activityPhaseTitle(
  phase: ActivityPhase,
  live = false,
  cwd?: string,
): string {
  if (phase.kind === "think") return live ? "Thinking" : "Thought";
  return groupPhrase(phase.steps, cwd, live) || (live ? "Working" : "Worked");
}

/** True when a nested scroller should consume this wheel, not the parent. */
export function nestedScrollAbsorbsWheel(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  deltaY: number,
): boolean {
  if (el.scrollHeight <= el.clientHeight + 1) return false;
  const atTop = el.scrollTop <= 0;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
  return (deltaY < 0 && !atTop) || (deltaY > 0 && !atBottom);
}
