import type { Attachment, Block, QuestionMeta } from "../session";
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

/** The turn ending closes every open user section — each gets its own timer. */
function closeUserTurns(blocks: Block[], ts: number): Block[] {
  let next = blocks;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.role === "user" && b.doneTs === undefined && !b.pending) {
      if (next === blocks) next = blocks.slice();
      next[i] = { ...b, doneTs: ts };
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

const OPEN_STATUSES = new Set(["starting", "running", "waiting"]);
const COMPACTING = "Compacting context";

function withCompaction(blocks: Block[], idx: number, compaction: Block["compaction"]): Block[] {
  if (idx < 0 || blocks[idx]?.role !== "system") return blocks;
  const next = blocks.slice();
  next[idx] = { ...next[idx], compaction };
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

/** A subagent step under a spawning call: the parent's chip counts it. */
function countSubStep(blocks: Block[], parentCallId: string): Block[] {
  const idx = findLastIndex(blocks, (b) => b.tool?.callId === parentCallId);
  if (idx < 0) return blocks;
  const next = blocks.slice();
  const parent = next[idx];
  next[idx] = { ...parent, tool: { ...parent.tool, subCount: (parent.tool?.subCount ?? 0) + 1 } };
  return next;
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
  const fresh = (prefix: string): string => `${prefix}:${nextId++}`;
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
      const stamp = e as { model?: string; reasoning?: string; context1m?: boolean; newPass?: boolean };
      const turn =
        stamp.model || stamp.reasoning || stamp.context1m !== undefined
          ? { turn: { model: stamp.model, reasoning: stamp.reasoning, context1m: stamp.context1m } }
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
          startedAt: row.ts,
          ts: row.ts,
          ...turn,
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
            ...turn,
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
          { id: key ?? fresh(role === "assistant" ? "a" : "r"), role, text: e.text, streaming: e.delta },
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
      blocks = upsertToolBlock(
        blocks,
        cwd,
        {
          callId: e.callId,
          title: title || e.name,
          kind: toolKind(e.name),
          status: "running",
          // The raw input reaches the preview: normalized patches are arrays.
          preview: e.preview ?? previewFromTool(e.name, e.input),
          streaming: true,
          extra: {
            name: e.name,
            ...(e.partial
              ? { partialInput: e.input }
              : { input: e.input, partialInput: undefined }),
            ...(e.display ? { display: e.display } : {}),
            ...(e.parentCallId ? { parentCallId: e.parentCallId } : {}),
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
      blocks = upsertToolBlock(
        blocks,
        cwd,
        {
          callId: e.callId,
          status: e.isError ? "failed" : "completed",
          detail: e.output,
          preview: previewFromTool(name, input, e.output),
          streaming: false,
          ...(e.reauth ? { extra: { reauth: e.reauth } } : {}),
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
        },
        `ap:${e.requestId}`,
      );
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
        approval: { requestId: e.requestId, decided, ...(auto ? { auto } : {}) },
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
      if ((e.status === "idle" || e.status === "error") && (thread.turnOpen || thread.inPass)) {
        const t = th();
        t.turnOpen = false;
        t.inPass = false;
        blocks = closeUserTurns(blocks, row.ts);
      }
      // "awaiting approval"/"awaiting answer" already show as cards.
      if (e.detail && e.status !== "waiting") {
        blocks = appendStatusBlock(blocks, e.detail, fresh("s"));
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
        { id: `err:${row.seq}`, role: "system", text: e.message, ...(e.stopped ? { stopped: true } : {}) },
      ];
      if (e.stopped) {
        blocks = settleOpenTools(blocks);
        busy = false;
        th().stopped = true;
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
      if (e.phase === "start") {
        blocks = appendStatusBlock(blocks, COMPACTING, fresh("s"));
        blocks = withCompaction(blocks, blocks.length - 1, { ...meta, startedAt: row.ts });
        th().compacting = true;
      } else {
        const note =
          e.phase === "done"
            ? "Context compacted"
            : `Compaction failed${e.error ? `: ${e.error}` : ""}`;
        // The start note becomes the outcome when nothing came between.
        const last = blocks[blocks.length - 1];
        if (last?.role === "system" && last.text === COMPACTING) {
          blocks = blocks.slice();
          blocks[blocks.length - 1] = { ...last, text: note };
          blocks = withCompaction(blocks, blocks.length - 1, { ...last.compaction, ...meta });
        } else {
          blocks = appendStatusBlock(blocks, note, fresh("s"));
          blocks = withCompaction(blocks, blocks.length - 1, meta);
        }
        // The meter drops with the transcript: the next turn's reading
        // confirms, but the user should not wait for it.
        if (e.phase === "done" && e.postTokens !== undefined) {
          context = mergeContextUsage(context, { used: e.postTokens });
        }
        if (thread.compacting) th().compacting = false;
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
      blocks = withAgent(blocks, { id: e.agentId, title: e.title, status: e.status });
      break;
    case "agent-spawned":
      blocks = appendStatusBlock(blocks, `Spawned agent ${e.childSessionId}`, fresh("s"));
      blocks = withAgent(blocks, { id: e.childSessionId });
      if (!thread.agents.includes(e.childSessionId)) {
        const t = th();
        t.agents = [...t.agents, e.childSessionId];
      }
      break;
    case "goal":
      blocks = appendStatusBlock(blocks, `Goal ${e.phase}: ${e.condition}`, fresh("s"));
      break;
    case "research-source": {
      // Kept whole for the research board; a repeat callId only enriches
      // the earlier row (a late-arriving title).
      const t = th();
      const i = t.sources.findIndex((src) => src.callId === e.callId);
      const source = { callId: e.callId, url: e.url, query: e.query, agentId: e.agentId, agentLabel: e.agentLabel, title: e.title, ts: row.ts };
      t.sources =
        i >= 0
          ? t.sources.map((src, n) => (n === i ? { ...src, ...(e.title ? { title: e.title } : {}), ...(e.url ? { url: e.url } : {}) } : src))
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
    kind: a.kind === "image" ? "image" : "file",
    size: 0,
    path: a.path,
  };
}

function findLastIndex<T>(list: T[], pred: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i])) return i;
  return -1;
}
