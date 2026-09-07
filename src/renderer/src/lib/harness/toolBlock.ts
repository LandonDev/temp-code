import type { Block, Session, ToolPreview } from "../session";
import { displayPath } from "../paths";
import {
  composeToolTitle,
  isFileTool,
  isWeakToolTitle,
  mergeToolPreview,
  stubFilePreview,
} from "./preview";

/**
 * Pure block-level helpers shared by the harness reducers: how a tool call
 * becomes (or updates) a transcript block, how an approval attaches to
 * one, and the small stream-sealing rules around them. `cwd` shortens
 * paths in labels.
 */

export type ToolPatch = {
  callId: string;
  title?: string;
  kind?: string;
  status?: string;
  detail?: string;
  preview?: ToolPreview;
  streaming: boolean;
  /** Extra tool fields kept verbatim on the block (name, input). */
  extra?: Partial<NonNullable<Block["tool"]>>;
};

export type ApprovalAttach = {
  requestId: string | number;
  title: string;
  kind?: string;
  callId?: string;
  preview?: ToolPreview;
  /** The provider's tool name and arguments, kept so the row can say what
   *  the call is in plain words even when no call id ties it to a call. */
  name?: string;
  input?: unknown;
};

export const MAX_TOOL_DETAIL_CHARS = 8_000;

export function upsertToolBlock(
  blocks: Block[],
  cwd: string,
  patch: ToolPatch,
  id?: string,
): Block[] {
  const index = findToolIndex(blocks, patch);
  if (index < 0) {
    const detail = capToolDetail(patch.detail);
    const preview = fillPreview(patch.preview, patch.kind, patch.title);
    const label = finalToolLabel(cwd, patch.kind, displayLabel(patch), preview);
    return [
      ...sealLastStream(blocks),
      {
        id: id ?? crypto.randomUUID(),
        role: "tool",
        text: label,
        streaming: patch.streaming,
        tool: {
          callId: patch.callId,
          title: label,
          kind: patch.kind,
          status: patch.status,
          ...(detail ? { detail } : {}),
          ...(preview ? { preview } : {}),
          ...(patch.extra ?? {}),
        },
      },
    ];
  }
  const prev = blocks[index];
  const detail = capToolDetail(patch.detail) ?? prev.tool?.detail;
  const preview = fillPreview(
    mergeToolPreview(patch.preview, prev.tool?.preview),
    patch.kind ?? prev.tool?.kind,
    patch.title,
  );
  const label = finalToolLabel(
    cwd,
    patch.kind ?? prev.tool?.kind,
    displayLabel(patch, prev),
    preview,
  );
  const kind = patch.kind ?? prev.tool?.kind;
  const status = patch.status ?? prev.tool?.status;
  if (
    !patch.extra &&
    prev.text === label &&
    prev.streaming === patch.streaming &&
    prev.tool?.title === label &&
    prev.tool?.kind === kind &&
    prev.tool?.status === status &&
    prev.tool?.detail === detail &&
    samePreview(prev.tool?.preview, preview)
  ) {
    return blocks;
  }
  const next = blocks.slice();
  next[index] = {
    ...prev,
    text: label,
    streaming: patch.streaming,
    tool: {
      ...prev.tool,
      callId: patch.callId,
      title: label,
      kind,
      status,
      ...(detail ? { detail } : {}),
      ...(preview ? { preview } : {}),
      ...(patch.extra ?? {}),
    },
  };
  return next;
}

/** Attach an approval to the tool block it guards, or append one for it. */
export function attachApprovalBlock(
  blocks: Block[],
  cwd: string,
  event: ApprovalAttach,
  id?: string,
): Block[] {
  const index = findToolForApproval(blocks, event);
  if (index >= 0) {
    const next = blocks.slice();
    const prev = next[index];
    const preview = mergeToolPreview(event.preview, prev.tool?.preview);
    const label =
      finalToolLabel(
        cwd,
        event.kind ?? prev.tool?.kind,
        preferLabel(event.title, prev.tool?.title, prev.text),
        preview,
      ) || prev.text;
    next[index] = {
      ...prev,
      text: label || prev.text,
      tool: prev.tool
        ? {
            ...prev.tool,
            kind: event.kind ?? prev.tool.kind,
            title: label || prev.tool.title,
            ...(preview ? { preview } : {}),
            ...(event.name && !prev.tool.name
              ? { name: event.name, input: event.input }
              : {}),
          }
        : event.callId
          ? {
              callId: event.callId,
              title: label,
              kind: event.kind,
              ...(preview ? { preview } : {}),
              ...(event.name ? { name: event.name, input: event.input } : {}),
            }
          : prev.tool,
      approval: { requestId: event.requestId },
    };
    return next;
  }
  const preview = event.preview;
  const label =
    finalToolLabel(cwd, event.kind, preferLabel(event.title), preview) ||
    kindTitle(event.kind);
  return [
    ...sealLastStream(blocks),
    {
      id: id ?? crypto.randomUUID(),
      role: "tool",
      text: label,
      tool: {
        ...(event.callId ? { callId: event.callId } : {}),
        title: label,
        kind: event.kind,
        ...(preview ? { preview } : {}),
        ...(event.name ? { name: event.name, input: event.input } : {}),
      },
      approval: { requestId: event.requestId },
    },
  ];
}

function findToolForApproval(blocks: Block[], event: ApprovalAttach): number {
  // A call id names its invocation outright; when that call has no block
  // yet, the card stands on its own and the call joins it by id.
  if (event.callId) {
    return blocks.findIndex((block) => block.tool?.callId === event.callId);
  }
  // No call id: only a call from this turn still waiting on its result can
  // be the one asked about. Settled calls from earlier never take a card.
  let start = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].role === "user") {
      start = i + 1;
      break;
    }
  }
  const candidate = (block: Block) =>
    block.role === "tool" && !block.approval && isOpenTool(block);
  if (event.name) {
    for (let i = blocks.length - 1; i >= start; i--) {
      const block = blocks[i];
      if (candidate(block) && block.tool?.name === event.name) return i;
    }
  }
  const needle = normalizeLabel(event.title);
  const unmatched: number[] = [];
  for (let i = blocks.length - 1; i >= start; i--) {
    const block = blocks[i];
    if (!candidate(block)) continue;
    unmatched.push(i);
    const label = normalizeLabel(block.text || block.tool?.title || "");
    if (needle && label === needle) return i;
  }
  return unmatched.length === 1 ? unmatched[0] : -1;
}

export function normalizeLabel(value: string): string {
  return value
    .replace(/[→`]/g, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s*·.*$/, "")
    .trim()
    .toLowerCase();
}

function findToolIndex(
  blocks: Block[],
  patch: { callId: string; title?: string },
): number {
  if (patch.callId) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].tool?.callId === patch.callId) return i;
    }
  }
  const needle = normalizeLabel(patch.title || "");
  if (!needle) return -1;
  return blocks.findIndex((block) => {
    if (block.role !== "tool" || !block.approval || block.tool?.callId) {
      return false;
    }
    return normalizeLabel(block.text || block.tool?.title || "") === needle;
  });
}

export function capToolDetail(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (text.length <= MAX_TOOL_DETAIL_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_DETAIL_CHARS)}\n…`;
}

function samePreview(a?: ToolPreview, b?: ToolPreview): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.kind === b.kind &&
    a.path === b.path &&
    a.query === b.query &&
    a.fileName === b.fileName &&
    a.additions === b.additions &&
    a.deletions === b.deletions &&
    a.startLine === b.startLine &&
    a.output === b.output &&
    a.lines === b.lines
  );
}

function fillPreview(
  preview: ToolPreview | undefined,
  kind?: string,
  title?: string,
): ToolPreview | undefined {
  if (
    preview?.lines?.some((line) => line.kind === "add" || line.kind === "del")
  ) {
    return preview;
  }
  if (preview) return { ...preview, lines: undefined };
  if (isFileTool(kind, title, preview)) {
    return stubFilePreview(kind, title);
  }
  return undefined;
}

/** A finished text/reasoning stream at the tail stops streaming before anything is appended after it. */
export function sealLastStream(blocks: Block[]): Block[] {
  const last = blocks[blocks.length - 1];
  if (
    !last?.streaming ||
    (last.role !== "assistant" && last.role !== "reasoning")
  ) {
    return blocks.slice();
  }
  const next = blocks.slice();
  next[next.length - 1] = { ...last, streaming: false };
  return next;
}

/** Status pings repeat; keep one row per run instead of stacking identical lines. */
export function appendStatusBlock(
  blocks: Block[],
  text: string,
  id?: string,
): Block[] {
  const trimmed = text.trim();
  if (!trimmed) return blocks;
  const last = [...blocks].reverse().find((block) => block.role !== "reasoning");
  if (last?.role === "system" && last.text === trimmed) return blocks;
  return [
    ...sealLastStream(blocks),
    { id: id ?? crypto.randomUUID(), role: "system", text: trimmed },
  ];
}

export function stampTurnDuration(blocks: Block[], now: number): Block[] {
  let lastUser = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return blocks;
  const user = blocks[lastUser];
  if (user.durationMs != null || user.startedAt == null) return blocks;
  const next = blocks.slice();
  next[lastUser] = { ...user, durationMs: Math.max(0, now - user.startedAt) };
  return next;
}

/** The session view after its turn ends: not busy, nothing streaming. */
export function stopStreaming(session: Session): Session {
  return {
    ...session,
    busy: false,
    blocks: stopStreamingBlocks(session.blocks, Date.now()),
  };
}

/** Every streaming block stops; the open user turn gets its duration. */
export function stopStreamingBlocks(blocks: Block[], now: number): Block[] {
  return stampTurnDuration(
    blocks.map((block) => (block.streaming ? { ...block, streaming: false } : block)),
    now,
  );
}

const OPEN_TOOL_STATUSES = new Set(["running", "pending", "in_progress"]);

/** A call still waiting on its result (or one that never reported a status). */
export function isOpenTool(block: Block): boolean {
  const status = block.tool?.status?.toLowerCase();
  return !status || OPEN_TOOL_STATUSES.has(status);
}

/** The turn is over: a call still shown running will never finish. */
export function settleOpenTools(blocks: Block[]): Block[] {
  let next = blocks;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const status = block.tool?.status?.toLowerCase();
    if (!block.tool || !status || !OPEN_TOOL_STATUSES.has(status)) continue;
    if (next === blocks) next = blocks.slice();
    next[i] = { ...block, streaming: false, tool: { ...block.tool, status: "cancelled" } };
  }
  return next;
}

/** A paused turn resumes: its clock restarts where the pause stopped it. */
export function resumeTurnClock(blocks: Block[], now: number): Block[] {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.role !== "user") continue;
    if (block.durationMs == null || block.doneTs !== undefined || block.startedAt == null) {
      return blocks;
    }
    const { durationMs, ...rest } = block;
    const next = blocks.slice();
    next[i] = { ...rest, startedAt: now - durationMs };
    return next;
  }
  return blocks;
}

function displayLabel(
  patch: { title?: string; kind?: string },
  prev?: Block,
): string {
  return (
    preferLabel(patch.title, prev?.tool?.title, prev?.text) ||
    kindTitle(patch.kind ?? prev?.tool?.kind)
  );
}

function finalToolLabel(
  cwd: string,
  kind: string | undefined,
  title: string | undefined,
  preview?: ToolPreview,
): string {
  const path = preview?.path
    ? displayPath(preview.path, cwd)
    : preview?.fileName;
  return (
    composeToolTitle({
      kind,
      title,
      path,
      query: preview?.query,
      previewKind: preview?.kind,
      cwd,
    }) ||
    title?.trim() ||
    kindTitle(kind)
  );
}

function preferLabel(...parts: (string | undefined)[]): string {
  const filled = parts
    .filter((part): part is string => !!part?.trim())
    .map((part) => part.trim())
    .filter((part) => !isCallId(part));
  const strong = filled.filter(
    (part) => !isWeakToolTitle(part) && compactLabel(part) === part,
  );
  strong.sort((a, b) => b.length - a.length);
  if (strong[0]) return strong[0];
  const compact = filled.filter((part) => compactLabel(part) === part);
  compact.sort((a, b) => b.length - a.length);
  return compact[0] ?? filled[0] ?? "";
}

function compactLabel(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  if (trimmed.includes("\n") || trimmed.length > 240) return undefined;
  return trimmed;
}

export function kindTitle(kind?: string): string {
  const key = kind?.trim().toLowerCase() ?? "";
  switch (key) {
    case "read":
      return "Read";
    case "edit":
      return "Edit";
    case "delete":
      return "Delete";
    case "move":
      return "Move";
    case "search":
      return "Find";
    case "execute":
    case "shell":
    case "bash":
      return "Shell";
    case "skill":
      return "Skill";
    case "think":
      return "Think";
    case "fetch":
      return "Fetch";
    case "other":
    case "":
      return "Working";
    default:
      return key.replace(/^_/, "").replace(/[_-]+/g, " ");
  }
}

function isCallId(value: string): boolean {
  const text = value.trim();
  return (
    /^(call[-_]?|tool[-_])[a-z0-9_-]+$/i.test(text) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)
  );
}
