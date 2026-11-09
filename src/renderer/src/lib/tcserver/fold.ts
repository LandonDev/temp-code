import { carryPendingApprovalIndex, type Attachment, type Block, type CompactionMeta, type QuestionMeta } from "../session";
import { BACKGROUND_CHECK_WORDS, COMPACTING_WORDS } from "@shared/statusWords";
import { mergeContextUsage, type ContextUsage } from "../contextUsage";
import {
  asRecord,
  previewFromTool,
  toolKindFromName,
  toolTitle,
} from "../harness/claudeProtocol";
import {
  appendStatusBlock,
  attachApprovalBlock,
  resumeTurnClock,
  sealLastStream,
  settleOpenTools,
  stopStreamingBlocks,
  upsertToolBlock,
} from "../harness/toolBlock";
import type { EventRow, ServerAttachment } from "./types";
import { isOmittedBody } from "@server/shared/wire";
import { shortName } from "../toolPhrase";
import type { ToolPreview } from "../session";
import {
  applyTaskResult,
  applyTodoCall,
  beginTurn,
  emptyThread,
  markUsage,
  type ThreadState,
} from "./todos";

export type { ThreadState, TodoItem, TodoStatus, UsageMark, ResearchSource } from "./todos";

/** MCP tool names carry the server and tool name; their kind is never
 *  inferable from the words inside ("app_list_threads" is not a read). */
function toolKind(name: string): string {
  return name.startsWith("mcp__") ? "other" : toolKindFromName(name);
}

/**
 * The server's event log, folded into MonoCode's transcript blocks. Pure:
 * one row in, a new state out (unchanged rows return the same state, so
 * React sees no change). Live pushes and a replay of the stored log fold
 * to the same blocks because text is keyed by `msgId:blockIndex` and tools
 * by `callId` — an ephemeral streaming row and its persisted final land
 * on the same block.
 */
export type FoldState = {
  blocks: Block[];
  /** A turn is open: the harness is starting, running, or waiting on us. */
  busy: boolean;
  context?: ContextUsage;
  /** Highest persisted seq folded; ephemeral rows (seq -1) never move it. */
  lastSeq: number;
  /** Counter for blocks with no natural key. */
  nextId: number;
  /** Board state beside the transcript: todos, rounds, cost, sources. */
  thread: ThreadState;
};

export function emptyFold(): FoldState {
  return { blocks: [], busy: false, lastSeq: 0, nextId: 1, thread: emptyThread() };
}

/** Timestamp of the last stamped block — how a dead turn is recognized. */
function lastBlockTs(blocks: Block[]): number | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const ts = blocks[i].ts;
    if (ts !== undefined) return ts;
  }
  return undefined;
}

/** New blocks land at the tail unstamped; give them their round, todo and time. */
function stampTail(blocks: Block[], thread: ThreadState, ts: number | undefined): Block[] {
  let end = blocks.length;
  while (end > 0 && blocks[end - 1].round === undefined) end--;
  if (end === blocks.length) return blocks;
  const next = blocks.slice();
  for (let i = end; i < next.length; i++) {
    next[i] = {
      ...next[i],
      round: thread.round,
      todo: thread.activeTodo,
      ...(ts !== undefined && next[i].ts === undefined ? { ts } : {}),
      ...(thread.inPass ? { pass: true } : {}),
    };
  }
  return next;
}

/** The turn ending closes every open user section — each gets its own
 *  timer. `stopped`: the host put the turn down with its harness gone, and
 *  a Resume carries the span on (resumeTurnClock). */
function closeUserTurns(blocks: Block[], ts: number, stopped = false): Block[] {
  let next = blocks;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.role === "user" && b.doneTs === undefined && !b.pending) {
      if (next === blocks) next = blocks.slice();
      next[i] = { ...b, doneTs: ts, ...(stopped ? { stoppedTs: ts } : {}) };
    }
  }
  return next;
}

export function foldAll(
  rows: EventRow[],
  cwd: string,
  state: FoldState = emptyFold(),
): FoldState {
  return rows.reduce((acc, row) => foldEvent(acc, row, cwd), state);
}

type UserTurnExtra = {
  secondOpinion?: Block["secondOpinion"];
  noteCard?: Block["noteCard"];
};

/** Show the user's message the instant they hit send; the echoed
 *  `user-text` row claims this block instead of appending a second one. */
export function foldOptimisticUser(
  state: FoldState,
  text: string,
  attachments: Attachment[] = [],
  extra?: UserTurnExtra,
  newPass?: boolean,
): FoldState {
  const now = Date.now();
  const thread = { ...state.thread };
  beginTurn(thread, now, lastBlockTs(state.blocks), newPass);
  const block: Block = {
    id: `pending:${state.nextId}`,
    role: "user",
    text,
    startedAt: now,
    pending: true,
    pendingAfter: state.lastSeq,
    born: now,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(extra?.secondOpinion ? { secondOpinion: extra.secondOpinion } : {}),
    ...(extra?.noteCard ? { noteCard: extra.noteCard } : {}),
  };
  return {
    ...state,
    busy: true,
    nextId: state.nextId + 1,
    thread,
    blocks: stampTail([...sealLastStream(state.blocks), block], thread, now),
  };
}

/** The echo takes the optimistic row's place on screen: its key (the row
 *  never changes key), its entrance, its previews and its chips. */
function claimPending(echo: Block, pending: Block): Block {
  return {
    ...echo,
    rowKey: pending.rowKey ?? pending.id,
    ...(pending.born !== undefined ? { born: pending.born } : {}),
    ...(pending.attachments?.length ? { attachments: pending.attachments } : {}),
    ...(pending.secondOpinion ? { secondOpinion: pending.secondOpinion } : {}),
    ...(pending.noteCard ? { noteCard: pending.noteCard } : {}),
  };
}

/**
 * After a refold from the rows alone (a head paged in, an older page), the
 * optimistic rows the entry still holds meet the refolded log. Each is
 * matched to its echo: a persisted user row past the seq the send followed
 * (`pendingAfter`), the same text first, else the next in order; the echo
 * stands and takes the row's key (`claimPending`). One with no echo in the
 * log yet stays pending: FIRST when the loaded rows start past the seq it
 * followed (its echo lies in the gap before them, where the next older page
 * or the live claim will find it), LAST when nothing persisted since could
 * hold it (the host has not written it). Appended last after the echo had
 * folded, a pending row sat under the whole stream and the working line
 * read Sending for the rest of the turn.
 */
export function reconcilePending(state: FoldState, pending: Block[]): FoldState {
  if (pending.length === 0) return state;
  let blocks = state.blocks;
  const taken = new Set<number>();
  const before: Block[] = [];
  const after: Block[] = [];
  let firstSeq = Infinity;
  for (const b of blocks) if (b.seq !== undefined && b.seq < firstSeq) firstSeq = b.seq;
  let from = 0;
  for (const p of pending) {
    const floor = p.pendingAfter ?? 0;
    const candidates: number[] = [];
    for (let i = from; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.role === "user" && !b.pending && b.seq !== undefined && b.seq > floor && !taken.has(i)) candidates.push(i);
    }
    const idx = candidates.find((i) => blocks[i].text === p.text) ?? candidates[0];
    if (idx === undefined) {
      (floor + 1 < firstSeq ? before : after).push(p);
      continue;
    }
    taken.add(idx);
    from = idx + 1;
    if (blocks === state.blocks) blocks = blocks.slice();
    blocks[idx] = claimPending(blocks[idx], p);
  }
  if (before.length === 0 && after.length === 0 && blocks === state.blocks) return state;
  return { ...state, blocks: [...before, ...blocks, ...after] };
}

const OPEN_STATUSES = new Set(["starting", "running", "waiting"]);
const COMPACTION_STOPPED = "Compaction stopped";

/** The open compaction's row, by the id the start stamped; -1 when none is open. */
function openCompactionIndex(blocks: Block[], thread: ThreadState): number {
  if (!thread.compactionId) return -1;
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].id === thread.compactionId) return i;
  return -1;
}

/** The open compaction's row takes its outcome in place, wherever it sits. */
function closeCompaction(blocks: Block[], idx: number, text: string, meta: Partial<CompactionMeta>): Block[] {
  const next = blocks.slice();
  const row = next[idx];
  next[idx] = { ...row, text, compaction: { ...row.compaction, ...meta } as CompactionMeta };
  return next;
}

/** Stamp the child on the status row just appended (a repeat note appends nothing). */
function withAgent(blocks: Block[], agent: NonNullable<Block["agent"]>): Block[] {
  const last = blocks[blocks.length - 1];
  if (last?.role !== "system" || last.agent?.id === agent.id) return blocks;
  const next = blocks.slice();
  next[next.length - 1] = { ...last, agent };
  return next;
}

/** How many children a spawn_agent call asked for: its `agents` list, else one. */
function spawnsAskedFor(tool: NonNullable<Block["tool"]>): number {
  const input = asRecord(tool.input ?? tool.partialInput);
  return Array.isArray(input?.agents) ? Math.max(1, input.agents.length) : 1;
}

/**
 * The host spawned a child: the call that asked for it gains the id, so the
 * call's row is the one row of the spawn. The newest spawn_agent call of
 * the turn with room left takes it; a repeat changes nothing. Null when no
 * call in the turn asked (an older log): the caller appends a row instead.
 */
function stampSpawn(blocks: Block[], id: string): Block[] | null {
  let start = blocks.length;
  while (start > 0 && blocks[start - 1].role !== "user") start--;
  let target = -1;
  for (let i = blocks.length - 1; i >= start; i--) {
    const tool = blocks[i].tool;
    if (!tool?.name || shortName(tool.name) !== "spawn_agent") continue;
    const spawned = tool.spawned ?? [];
    if (spawned.includes(id)) return blocks;
    if (target < 0 && spawned.length < spawnsAskedFor(tool)) target = i;
  }
  if (target < 0) return null;
  const next = blocks.slice();
  const b = next[target];
  next[target] = { ...b, tool: { ...b.tool, spawned: [...(b.tool?.spawned ?? []), id] } };
  return next;
}

/** A subagent step under a spawning call: the parent's chip counts it. */
function countSubStep(blocks: Block[], parentCallId: string): Block[] {
  const idx = findLastIndex(blocks, (b) => b.tool?.callId === parentCallId);
  if (idx < 0) return blocks;
  const next = blocks.slice();
  const parent = next[idx];
  next[idx] = { ...parent, tool: { ...parent.tool, subCount: (parent.tool?.subCount ?? 0) + 1 } };
  return next;
}

/** Remote profile: bytes of the OmittedBody values inside `value` (0 when none). */
function omittedBytes(value: unknown, depth = 0): number {
  if (isOmittedBody(value)) return value.bytes;
  if (!value || typeof value !== "object" || depth > 8) return 0;
  let n = 0;
  for (const v of Object.values(value as Record<string, unknown>)) n += omittedBytes(v, depth + 1);
  return n;
}

/** The block's `omitted` record with this row added; nothing when the row
 *  carries no omitted body, is ephemeral, or is already recorded. */
function omittedAfter(
  prev: Block | undefined,
  row: EventRow,
  bytes: number,
): { omitted?: NonNullable<Block["tool"]>["omitted"] } {
  if (bytes <= 0 || row.ephemeral || row.seq < 0) return {};
  const before = prev?.tool?.omitted;
  if (before?.seqs.includes(row.seq)) return {};
  return {
    omitted: {
      sessionId: row.sessionId,
      seqs: before ? [...before.seqs, row.seq] : [row.seq],
      bytes: (before?.bytes ?? 0) + bytes,
    },
  };
}

/** A preview as the renderer may hold it: diff lines or an output that
 *  left the wire become absent; the path and the counts stay. */
function wirePreview(preview: ToolPreview | undefined): ToolPreview | undefined {
  if (!preview) return preview;
  const lines = isOmittedBody(preview.lines) ? undefined : preview.lines;
  const output = isOmittedBody(preview.output) ? undefined : preview.output;
  return lines === preview.lines && output === preview.output ? preview : { ...preview, lines, output };
}

/** The text a tool result carries on the wire: the output, or an omitted
 *  body's first line until the row is fetched whole. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  return isOmittedBody(output) ? output.head : "";
}

export function foldEvent(
  state: FoldState,
  row: EventRow,
  cwd: string,
): FoldState {
  const e = row.event;
  const persisted = !row.ephemeral && row.seq >= 0;
  // A row already folded (a live push that history then repeats) is a no-op.
  if (persisted && row.seq <= state.lastSeq) return state;
  let { blocks, busy, context, nextId, thread } = state;
  const lastSeq = persisted ? Math.max(state.lastSeq, row.seq) : state.lastSeq;
  // A persisted row mints ids from its seq, so a block gets the same id
  // whether it folded from a tail-first paint or from the whole log.
  let minted = 0;
  const fresh = (prefix: string): string =>
    persisted ? `${prefix}:${row.seq}${minted++ ? `.${minted}` : ""}` : `${prefix}:${nextId++}`;
  /** Copy-on-write view of the thread state. */
  const th = (): ThreadState => {
    if (thread === state.thread) thread = { ...state.thread };
    return thread;
  };

  // In-harness subagent output: its tool calls show as ordinary tool
  // blocks (nesting arrives later); its prose stays out of the main flow.
  const nested = "parentCallId" in e && !!e.parentCallId;

  switch (e.type) {
    case "user-text": {
      const attachments = e.attachments?.length
        ? e.attachments.map(fromServerAttachment)
        : undefined;
      const stamp = e as {
        model?: string;
        reasoning?: string;
        context1m?: boolean;
        fast?: boolean;
        ultrafast?: boolean;
        newPass?: boolean;
        preamble?: { text: string; words: number };
      };
      const preamble = stamp.preamble ? { preamble: stamp.preamble } : {};
      const steer = e.steerId ? { steerId: e.steerId } : {};
      const turn =
        stamp.model || stamp.reasoning || stamp.context1m !== undefined
          ? {
              turn: {
                model: stamp.model,
                reasoning: stamp.reasoning,
                context1m: stamp.context1m,
                fast: stamp.fast,
                ultrafast: stamp.ultrafast,
              },
            }
          : {};
      let idx = blocks.findIndex((b) => b.pending && b.text === e.text);
      if (idx < 0) idx = blocks.findIndex((b) => b.pending);
      const id = `u:${row.seq}`;
      if (idx >= 0) {
        // The optimistic push already ran beginTurn — just claim the block.
        const { pending: _pending, ...prev } = blocks[idx];
        blocks = blocks.slice();
        blocks[idx] = {
          ...prev,
          id,
          // The row on screen keeps its key: the echo renames the block, not the row.
          rowKey: prev.rowKey ?? prev.id,
          startedAt: row.ts,
          ts: row.ts,
          ...(persisted ? { seq: row.seq } : {}),
          ...turn,
          ...preamble,
          ...steer,
          ...(prev.attachments?.length
            ? { attachments: prev.attachments }
            : attachments
              ? { attachments }
              : {}),
        };
      } else {
        beginTurn(th(), row.ts, lastBlockTs(blocks), stamp.newPass);
        blocks = [
          ...sealLastStream(blocks),
          {
            id,
            role: "user",
            text: e.text,
            startedAt: row.ts,
            ...(persisted ? { seq: row.seq } : {}),
            ...turn,
            ...preamble,
            ...steer,
            ...(attachments ? { attachments } : {}),
          },
        ];
      }
      busy = true;
      break;
    }
    case "assistant-text":
    case "thinking": {
      if (nested) break;
      const role = e.type === "thinking" ? "reasoning" : "assistant";
      const key =
        e.msgId !== undefined && e.blockIndex !== undefined
          ? `${e.msgId}:${e.blockIndex}`
          : null;
      let idx = -1;
      if (key) {
        idx = findLastIndex(blocks, (b) => b.id === key);
      } else {
        const last = blocks.length - 1;
        if (blocks[last]?.role === role && blocks[last].streaming) idx = last;
      }
      if (idx < 0) {
        if (e.delta && !e.text) break;
        blocks = [
          ...sealLastStream(blocks),
          {
            id: key ?? fresh(role === "assistant" ? "a" : "r"),
            role,
            text: e.text,
            streaming: e.delta,
            ...(persisted && role === "assistant" ? { seq: row.seq } : {}),
          },
        ];
        break;
      }
      const cur = blocks[idx];
      const text = e.delta ? cur.text + e.text : e.text;
      if (text === cur.text && cur.streaming === e.delta) break;
      blocks = blocks.slice();
      blocks[idx] = { ...cur, text, streaming: e.delta };
      break;
    }
    case "tool-call": {
      if (!nested) {
        // Plan-tool calls move the todo model first, so this block and
        // everything after it belong to the newly in-progress todo.
        const next = { ...thread };
        if (applyTodoCall(next, e)) thread = next;
      }
      const input = asRecord(e.input) ?? {};
      const title = e.display
        ? [e.display.app, e.display.action].filter(Boolean).join(": ")
        : toolTitle(e.name, input);
      const prevCall = blocks[findLastIndex(blocks, (b) => b.tool?.callId === e.callId)];
      blocks = upsertToolBlock(
        blocks,
        cwd,
        {
          callId: e.callId,
          title: title || e.name,
          kind: toolKind(e.name),
          status: "running",
          // The raw input reaches the preview: normalized patches are arrays.
          preview: wirePreview(e.preview) ?? previewFromTool(e.name, e.input),
          streaming: true,
          extra: {
            name: e.name,
            ...(e.partial
              ? { partialInput: e.input }
              : { input: e.input, partialInput: undefined }),
            ...(e.display ? { display: e.display } : {}),
            ...(e.parentCallId ? { parentCallId: e.parentCallId } : {}),
            ...omittedAfter(prevCall, row, omittedBytes(e.input) + omittedBytes(e.preview)),
          },
        },
        e.callId,
      );
      if (e.parentCallId && !e.partial) {
        blocks = countSubStep(blocks, e.parentCallId);
      }
      if (persisted) {
        const idx = findLastIndex(blocks, (b) => b.tool?.callId === e.callId);
        if (idx >= 0 && blocks[idx].ts === undefined && blocks[idx].round !== undefined) {
          if (blocks === state.blocks) blocks = blocks.slice();
          blocks[idx] = { ...blocks[idx], ts: row.ts };
        }
      }
      break;
    }
    case "tool-result": {
      if (!nested) {
        const next = { ...thread };
        if (applyTaskResult(next, e)) thread = next;
      }
      const prev = blocks[findLastIndex(blocks, (b) => b.tool?.callId === e.callId)];
      const name = prev?.tool?.name ?? "tool";
      const input = prev?.tool?.input ?? prev?.tool?.partialInput;
      const output = outputText(e.output);
      const extra = {
        ...(e.reauth ? { reauth: e.reauth } : {}),
        ...omittedAfter(prev, row, omittedBytes(e.output)),
      };
      blocks = upsertToolBlock(
        blocks,
        cwd,
        {
          callId: e.callId,
          status: e.isError ? "failed" : "completed",
          detail: output,
          preview: previewFromTool(name, input, output),
          streaming: false,
          ...(Object.keys(extra).length ? { extra } : {}),
        },
        e.callId,
      );
      {
        const idx = findLastIndex(blocks, (b) => b.tool?.callId === e.callId);
        if (idx >= 0 && blocks[idx].doneTs === undefined) {
          if (blocks === state.blocks) blocks = blocks.slice();
          blocks[idx] = { ...blocks[idx], doneTs: row.ts };
        }
      }
      break;
    }
    case "approval-request": {
      const input = asRecord(e.input) ?? {};
      blocks = attachApprovalBlock(
        blocks,
        cwd,
        {
          requestId: e.requestId,
          title: e.title ?? toolTitle(e.toolName, input) ?? e.toolName,
          kind: toolKind(e.toolName),
          callId: e.callId,
          preview: previewFromTool(e.toolName, e.input),
          name: e.toolName,
          input: e.input,
          choices: e.choices,
        },
        `ap:${e.requestId}`,
      );
      {
        const bytes = omittedBytes(e.input);
        const idx = bytes > 0 ? findLastIndex(blocks, (b) => b.approval?.requestId === e.requestId) : -1;
        if (idx >= 0 && blocks[idx].tool) {
          if (blocks === state.blocks) blocks = blocks.slice();
          blocks[idx] = { ...blocks[idx], tool: { ...blocks[idx].tool, ...omittedAfter(blocks[idx], row, bytes) } };
        }
      }
      busy = true;
      break;
    }
    case "approval-resolved": {
      // A policy verdict (timeout, interrupt) is still a denial; `auto`
      // records who decided, never a third state.
      const decided = e.allow ? "allow" : "deny";
      const auto = e.auto === true;
      const idx = findLastIndex(blocks, (b) => b.approval?.requestId === e.requestId);
      if (idx < 0) break;
      const cur = blocks[idx].approval;
      if (cur?.decided === decided && !!cur.auto === auto) break;
      blocks = blocks.slice();
      blocks[idx] = {
        ...blocks[idx],
        approval: { requestId: e.requestId, decided, ...(auto ? { auto } : {}), ...(cur?.choices ? { choices: cur.choices } : {}) },
      };
      break;
    }
    case "steer": {
      // The last row per steer wins; a row for a steer the window never
      // saw (its user row outside the loaded page) changes nothing.
      const idx = findLastIndex(blocks, (b) => b.steerId === e.steerId);
      if (idx < 0) break;
      blocks = blocks.slice();
      blocks[idx] = {
        ...blocks[idx],
        steer: {
          state: e.state,
          ts: row.ts,
          ...(e.how ? { how: e.how } : {}),
          ...(e.reason ? { reason: e.reason } : {}),
        },
      };
      break;
    }
    case "question-request": {
      const question: QuestionMeta = {
        sessionId: row.sessionId,
        requestId: e.requestId,
        questions: e.questions,
      };
      const title = e.questions[0]?.header?.trim() || "Question";
      // The harness's own tool call (claude's AskUserQuestion) already has a
      // block; the card attaches to it instead of standing beside it.
      const idx = e.callId ? findLastIndex(blocks, (b) => b.tool?.callId === e.callId) : -1;
      if (idx >= 0) {
        const prev = blocks[idx];
        blocks = blocks.slice();
        blocks[idx] = {
          ...prev,
          text: title,
          streaming: true,
          tool: { ...prev.tool, title, kind: "question", status: "running" },
          question,
        };
      } else {
        blocks = [
          ...sealLastStream(blocks),
          {
            id: `q:${e.requestId}`,
            role: "tool",
            text: title,
            streaming: true,
            tool: { callId: e.callId, title, kind: "question", status: "running" },
            question,
          },
        ];
      }
      busy = true;
      break;
    }
    case "question-resolved": {
      const idx = findLastIndex(blocks, (b) => b.question?.requestId === e.requestId);
      if (idx < 0) break;
      const prev = blocks[idx];
      blocks = blocks.slice();
      blocks[idx] = {
        ...prev,
        streaming: false,
        tool: { ...prev.tool, status: e.answers ? "completed" : "cancelled" },
        question: { ...prev.question!, answers: e.answers },
      };
      break;
    }
    case "status": {
      busy = OPEN_STATUSES.has(e.status);
      // A turn that ends or pauses with a compaction open: it stopped there.
      if (!busy && (thread.compacting || thread.compactionId)) {
        const open = openCompactionIndex(blocks, thread);
        if (open >= 0) blocks = closeCompaction(blocks, open, COMPACTION_STOPPED, { phase: "stopped", endedAt: row.ts });
        const t = th();
        t.compacting = false;
        t.compactionId = null;
      }
      if (e.status === "paused") {
        // The turn clock freezes with the work; resuming restarts it.
        blocks = stopStreamingBlocks(blocks, row.ts);
      } else if (!busy) {
        blocks = settleOpenTools(stopStreamingBlocks(blocks, row.ts));
      } else {
        blocks = resumeTurnClock(blocks, row.ts);
      }
      // Logged end-of-turn signals close the turn even when the
      // turn-complete event itself was lost (crash between the two).
      // 'watching' ends the turn too: the harness is idle behind its
      // background work, and the wake turn opens a fresh one. 'stopped'
      // ends it as well: the harness is gone, and Resume opens a new one.
      if (
        (e.status === "idle" || e.status === "error" || e.status === "watching" || e.status === "stopped") &&
        (thread.turnOpen || thread.inPass)
      ) {
        const t = th();
        t.turnOpen = false;
        t.inPass = false;
        blocks = closeUserTurns(blocks, row.ts, e.status === "stopped");
      }
      // "awaiting approval"/"awaiting answer" already show as cards.
      if (e.detail && e.status !== "waiting") {
        const before = blocks;
        blocks = appendStatusBlock(blocks, e.detail, fresh("s"));
        // The check on idle background tasks is a step of the work, not a row.
        if (blocks !== before && e.detail === BACKGROUND_CHECK_WORDS) {
          blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], backgroundCheck: true };
        }
      }
      break;
    }
    case "turn-complete": {
      blocks = closeUserTurns(settleOpenTools(stopStreamingBlocks(blocks, row.ts)), row.ts);
      busy = false;
      const t = th();
      t.turnOpen = false;
      t.inPass = false;
      if (e.costUsd !== undefined) t.cost = e.costUsd;
      markUsage(t, e.inputTokens, e.outputTokens);
      break;
    }
    case "context":
      context = mergeContextUsage(context, { used: e.tokens, window: e.window });
      break;
    case "error":
      blocks = [
        ...stopStreamingBlocks(blocks, row.ts),
        {
          id: `err:${row.seq}`,
          role: "system",
          text: e.message,
          ts: row.ts,
          ...(e.stopped ? { stopped: true } : {}),
          ...(e.failure ? { failure: e.failure } : {}),
        },
      ];
      if (e.stopped) {
        blocks = settleOpenTools(blocks);
        busy = false;
        th().stopped = true;
      }
      break;
    case "notice":
      // A plain system row (the account left this host, …): no failure, no stop.
      if (e.kind === "review" && e.review) {
        // The outcome card, its own row even when the text repeats (two
        // holds in a row read the same); a merged-anyway row settles the
        // hold it names.
        const review = e.review;
        blocks = [...sealLastStream(blocks), { id: `notice:${row.seq}`, role: "system", text: e.message, review }];
        if (review.outcome === "merged-anyway") {
          for (let i = blocks.length - 2; i >= 0; i--) {
            const r = blocks[i].review;
            if (r && r.runId === review.runId && r.outcome === "held" && !r.resolved) {
              blocks[i] = { ...blocks[i], review: { ...r, resolved: true } };
              break;
            }
          }
        }
      } else if (e.kind === "gate" && e.gate) {
        // A gate run's row: its own card, never folded into the status line.
        blocks = [...sealLastStream(blocks), { id: `notice:${row.seq}`, role: "system", text: e.message, gate: e.gate }];
      } else if (e.kind === "away") {
        // What the thread decided or the host answered while the person was
        // away: a row each, even when two read the same.
        const notice = e.away ? { kind: e.kind, away: e.away } : { kind: e.kind };
        blocks = [...sealLastStream(blocks), { id: `notice:${row.seq}`, role: "system", text: e.message, notice }];
      } else {
        // A batch's or an account's notice keeps its kind, so it draws typed.
        const next = appendStatusBlock(blocks, e.message, `notice:${row.seq}`);
        if (next !== blocks) next[next.length - 1] = { ...next[next.length - 1], notice: { kind: e.kind } };
        blocks = next;
      }
      break;
    case "errors-cleared": {
      // Continue settled every error shown so far; the system rows that
      // followed the last one (status detail, stopped note) go with it.
      let end = blocks.length;
      while (end > 0 && blocks[end - 1].role === "system") end--;
      const kept = blocks.slice(0, end).filter((b) => !b.id.startsWith("err:"));
      if (kept.length !== blocks.length) blocks = kept;
      if (thread.stopped) th().stopped = false;
      break;
    }
    case "compaction": {
      const { type: _type, ...meta } = e;
      // One row per compaction: the CLI repeats its start every 30 s while
      // it compacts (rows on disk keep the repeats), and a message can land
      // between the start and the outcome.
      const open = openCompactionIndex(blocks, thread);
      if (e.phase === "start") {
        if (open >= 0) break;
        const id = fresh("s");
        blocks = [...sealLastStream(blocks), { id, role: "system", text: COMPACTING_WORDS, compaction: { ...meta, startedAt: row.ts } }];
        const t = th();
        t.compacting = true;
        t.compactionId = id;
      } else {
        const note =
          e.phase === "done"
            ? "Context compacted"
            : `Compaction failed${e.error ? `: ${e.error}` : ""}`;
        if (open >= 0) blocks = closeCompaction(blocks, open, note, meta);
        else blocks = [...sealLastStream(blocks), { id: fresh("s"), role: "system", text: note, compaction: meta }];
        // The meter drops with the transcript: the next turn's reading
        // confirms, but the user should not wait for it.
        if (e.phase === "done" && e.postTokens !== undefined) {
          context = mergeContextUsage(context, { used: e.postTokens });
        }
        if (thread.compacting || thread.compactionId) {
          const t = th();
          t.compacting = false;
          t.compactionId = null;
        }
      }
      break;
    }
    case "plan":
      blocks = [...sealLastStream(blocks), { id: `p:${row.seq}`, role: "plan", text: e.text }];
      break;
    case "turn-pass":
      // The completed-turn pass opens here; blocks fold as pass work
      // until its turn-complete (or a status end) closes it.
      blocks = stampTail(appendStatusBlock(blocks, `Pass: ${e.actions.join(", ")}`, fresh("s")), thread, row.ts);
      th().inPass = true;
      break;
    case "agent-report":
      blocks = appendStatusBlock(blocks, `Agent ${e.title}: ${e.status}`, fresh("s"));
      // The batch's own report names the master itself: it reads as the batch and links nowhere.
      blocks = withAgent(blocks, {
        id: e.agentId,
        title: e.title,
        status: e.status,
        ...(e.agentId === row.sessionId ? { batch: true } : {}),
      });
      break;
    case "background-task":
      // A task that settled is a step of the run it woke (the driver never
      // emits one for ambient housekeeping); live work is the Activity section.
      blocks = [
        ...sealLastStream(blocks),
        {
          id: fresh("t"),
          role: "system",
          text: e.description,
          task: { id: e.taskId, label: e.description, status: e.status },
        },
      ];
      break;
    case "background-tasks":
      // No row: the live set is the right panel's Activity section.
      break;
    case "plan-handoff": {
      // The plan's quiet record of its build: a row that links to the thread.
      blocks = appendStatusBlock(blocks, `${e.how === "auto" ? "Implementation started" : "Build started"}: ${e.title}`, fresh("s"));
      const last = blocks[blocks.length - 1];
      if (last?.role === "system") {
        blocks = blocks.slice();
        blocks[blocks.length - 1] = { ...last, planHandoff: { id: e.sessionId, title: e.title, how: e.how } };
      }
      break;
    }
    case "agent-spawned": {
      // On the call, a child on another host is named as the call's result
      // names it (`<env>:<id>`); the fallback row keeps the id the store knows.
      const id = e.environmentId ? `${e.environmentId}:${e.childSessionId}` : e.childSessionId;
      const stamped = stampSpawn(blocks, id);
      if (stamped) {
        blocks = stamped;
      } else {
        blocks = appendStatusBlock(blocks, `Spawned agent ${e.childSessionId}`, fresh("s"));
        blocks = withAgent(blocks, { id: e.childSessionId });
      }
      if (!thread.agents.includes(e.childSessionId)) {
        const t = th();
        t.agents = [...t.agents, e.childSessionId];
      }
      break;
    }
    case "goal":
      blocks = appendStatusBlock(blocks, `Goal ${e.phase}: ${e.condition}`, fresh("s"));
      break;
    case "research-source": {
      // Kept whole for the research board; a repeat callId only enriches
      // the earlier row (a late-arriving title).
      const t = th();
      const i = t.sources.findIndex((src) => src.callId === e.callId);
      const source = { callId: e.callId, url: e.url, query: e.query, agentId: e.agentId, agentLabel: e.agentLabel, title: e.title, claim: e.claim, ts: row.ts };
      t.sources =
        i >= 0
          ? t.sources.map((src, n) =>
              n === i
                ? { ...src, ...(e.title ? { title: e.title } : {}), ...(e.url ? { url: e.url } : {}), ...(e.claim ? { claim: e.claim } : {}) }
                : src,
            )
          : [...t.sources, source];
      break;
    }
    case "usage":
      if (!nested && (e.inputTokens !== undefined || e.outputTokens !== undefined)) {
        markUsage(th(), e.inputTokens, e.outputTokens);
      }
      break;
  }

  if (blocks !== state.blocks) blocks = stampTail(blocks, thread, persisted ? row.ts : undefined);

  if (blocks !== state.blocks && (e.type === "assistant-text" || e.type === "thinking")) {
    carryPendingApprovalIndex(state.blocks, blocks);
  }

  if (
    blocks === state.blocks &&
    busy === state.busy &&
    context === state.context &&
    lastSeq === state.lastSeq &&
    nextId === state.nextId &&
    thread === state.thread
  ) {
    return state;
  }
  return { blocks, busy, context, lastSeq, nextId, thread };
}

export function fromServerAttachment(a: ServerAttachment): Attachment {
  return {
    id: a.path,
    name: a.name,
    mimeType: a.mime ?? "",
    kind: a.kind === "image" || a.kind === "appshot" ? "image" : "file",
    size: 0,
    path: a.path,
    ...(a.textPath ? { textPath: a.textPath } : {}),
  };
}

function findLastIndex<T>(list: T[], pred: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i])) return i;
  return -1;
}

/** Remote profile: fold one row fetched whole (`session.rowBody`) over the
 *  block it belongs to, the way the live fold did with the projected row;
 *  the block keeps its id and place. Rows of other kinds change nothing. */
export function applyRowBody(blocks: Block[], cwd: string, row: EventRow): Block[] {
  const e = row.event;
  switch (e.type) {
    case "tool-call": {
      const prev = blocks[findLastIndex(blocks, (b) => b.tool?.callId === e.callId)];
      if (!prev) return blocks;
      const input = asRecord(e.input) ?? {};
      const title = e.display
        ? [e.display.app, e.display.action].filter(Boolean).join(": ")
        : toolTitle(e.name, input);
      return upsertToolBlock(
        blocks,
        cwd,
        {
          callId: e.callId,
          title: title || e.name,
          kind: toolKind(e.name),
          preview: e.preview ?? previewFromTool(e.name, e.input),
          streaming: !!prev.streaming,
          extra: { name: e.name, input: e.input, partialInput: undefined },
        },
        e.callId,
      );
    }
    case "tool-result": {
      const prev = blocks[findLastIndex(blocks, (b) => b.tool?.callId === e.callId)];
      if (!prev) return blocks;
      const name = prev.tool?.name ?? "tool";
      return upsertToolBlock(
        blocks,
        cwd,
        {
          callId: e.callId,
          status: e.isError ? "failed" : "completed",
          detail: e.output,
          preview: previewFromTool(name, prev.tool?.input, e.output),
          streaming: false,
        },
        e.callId,
      );
    }
    case "approval-request": {
      const idx = findLastIndex(blocks, (b) => b.approval?.requestId === e.requestId);
      const prev = blocks[idx];
      if (idx < 0 || !prev.tool) return blocks;
      const next = blocks.slice();
      next[idx] = {
        ...prev,
        tool: {
          ...prev.tool,
          input: e.input,
          preview: previewFromTool(e.toolName, e.input) ?? prev.tool.preview,
        },
      };
      return next;
    }
    default:
      return blocks;
  }
}
