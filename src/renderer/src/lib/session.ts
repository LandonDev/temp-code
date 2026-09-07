import type { ContextUsage } from "./contextUsage";
import type { HandoffComposerCard } from "./handoff";
import type { InboxComposerCard } from "./githubTasks";
import type { NoteCardMeta, NoteComposerCard } from "./notes";
import {
  defaultSessionChoice,
  preferredModelId,
  preferredModelSettings,
  resolveModel,
} from "./models";
import type { ThreadRules } from "@server/shared/rules";
import type { AgentType, SessionStatus, ThreadType } from "./tcserver/types";
import type { ThreadState } from "./tcserver/todos";

export type HarnessId =
  "claude" | "codex" | "cursor" | "grok" | "opencode" | "pi" | "omp" | "fx";

export const HARNESSES: HarnessId[] = [
  "claude",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "pi",
  "omp",
  "fx",
];

export type BlockRole =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool"
  | "approval"
  | "plan"
  | "system"
  | "handoff";

export type HandoffStatus = "preparing" | "ready";

export type HandoffMeta = {
  from: HarnessId;
  to: HarnessId;
  status: HandoffStatus;
  /** Inject this brief into prompts to `to` until that harness accepts a turn. */
  pending?: boolean;
};

/** Compact transcript card for a second-opinion or split-pane handoff turn. */
export type SecondOpinionMeta = {
  from: HarnessId;
  to: HarnessId;
  request?: string;
  files?: number;
  /** Split-pane continue. Default is a second-opinion review. */
  kind?: "handoff";
};

export type ToolPreviewKind = "read" | "write" | "shell" | "search";

export type ToolPreviewLineKind = "add" | "del" | "context";

export type ToolPreviewLine = {
  number?: number;
  kind: ToolPreviewLineKind;
  text: string;
};

export type ToolPreview = {
  kind: ToolPreviewKind;
  title?: string;
  path?: string;
  fileName?: string;
  startLine?: number;
  additions?: number;
  deletions?: number;
  query?: string;
  lines?: ToolPreviewLine[];
  output?: string;
};

export type QuestionOption = { label: string; description?: string };

export type QuestionSpec = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  allowFreeform?: boolean;
  options: QuestionOption[];
};

export type QuestionMeta = {
  sessionId: string;
  requestId: string;
  questions: QuestionSpec[];
  /** Chosen labels per question once answered; null when dismissed. */
  answers?: string[][] | null;
};

export type AttachmentKind = "image" | "audio" | "file";

export type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  kind: AttachmentKind;
  size: number;
  /** Absolute path when the file lives on disk. */
  path?: string;
  /** Base64 payload for vision images (and pasted blobs) sent to the harness. */
  data?: string;
  /** Object URL for in-session thumbnails. Not persisted. */
  previewUrl?: string;
};

export type Block = {
  id: string;
  role: BlockRole;
  text: string;
  attachments?: Attachment[];
  streaming?: boolean;
  /** Epoch ms when this user turn started. */
  startedAt?: number;
  /** How long the agent worked on this user turn, in ms. */
  durationMs?: number;
  tool?: {
    callId?: string;
    title?: string;
    kind?: string;
    status?: string;
    detail?: string;
    preview?: ToolPreview;
    /** Provider tool name and input, kept so a result can re-render the preview. */
    name?: string;
    input?: unknown;
    /** Streaming preview of the input while the model still writes it. */
    partialInput?: unknown;
    /** Humanized face for addon calls (app + action). */
    display?: { app?: string; action?: string };
    /** A connector answered "reauthenticate"; the link fixes it. */
    reauth?: { app: string; url: string };
  };
  approval?: {
    requestId: string | number;
    decided?: "allow" | "deny";
    /** Resolved by policy (timeout, interrupt), not the user. */
    auto?: boolean;
  };
  /** The model stopped to ask; answered through the question card. */
  question?: QuestionMeta;
  /** Optimistic user turn the server has not echoed yet. */
  pending?: boolean;
  /** An error row the user's own Stop produced: reads Stopped, never Failed. */
  stopped?: boolean;
  handoff?: HandoffMeta;
  secondOpinion?: SecondOpinionMeta;
  /** Note chip shown on this user turn. Body is not stored; the harness already received it. */
  noteCard?: NoteCardMeta;
  /** Event time this block was born; `doneTs` when its work settled. */
  ts?: number;
  doneTs?: number;
  /** Which user request this block answers (0-based); see ThreadState. */
  round?: number;
  /** Index of the todo in progress when the block was born; -1 before any list. */
  todo?: number;
  /** Born during a completed-turn pass. */
  pass?: boolean;
  /** Run settings the server stamped on a user turn. */
  turn?: { model?: string; reasoning?: string; context1m?: boolean };
};

export type ThreadTasks = { done: number; total: number; current?: string | null };
export type ActivityKind = "think" | "investigate" | "edit";
export type ThreadGoal = { condition: string; iterations: number; setAt: number };

export type RuntimeMode =
  "supervised" | "auto-accept-edits" | "auto" | "full-access";

export const RUNTIME_MODES: RuntimeMode[] = [
  "supervised",
  "auto-accept-edits",
  "auto",
  "full-access",
];

export const DEFAULT_RUNTIME_MODE: RuntimeMode = "supervised";

export const RUNTIME_MODE_LABEL: Record<RuntimeMode, string> = {
  supervised: "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

export const RUNTIME_MODE_HINT: Record<RuntimeMode, string> = {
  supervised: "Ask before commands and file changes.",
  "auto-accept-edits": "Auto-approve edits, ask before other actions.",
  auto: "An AI reviewer approves routine actions; risky ones still ask.",
  "full-access": "Allow commands and edits without prompts.",
};

export type Session = {
  id: string;
  harness: HarnessId;
  model: string;
  modelSettings: Record<string, string>;
  runtimeMode: RuntimeMode;
  title: string;
  /** Project / working directory for this session. */
  cwd: string;
  /** Server project this thread belongs to; null = a loose chat. */
  projectId?: string | null;
  /** Workspace a loose chat hangs off (project threads reach theirs through the project). */
  workspaceId?: string | null;
  blocks: Block[];
  /** True while a harness turn is in flight. */
  busy?: boolean;
  /** Provider-side conversation id (Cursor ACP session id). */
  providerSessionId?: string;
  /** Context-window level reported by the harness. Absent until it reports. */
  context?: ContextUsage;
  /**
   * Composer switched providers, but the previous child is still live.
   * Handoff runs on the next send, not on picker change.
   */
  pendingSwitch?: PendingHarnessSwitch;
  /**
   * Last composer-pinned branch. Unused after session worktrees were removed;
   * kept so older session records still load.
   */
  branch?: string;
  /** Extra git worktree from the old session-branch feature. Unused. */
  worktreeCwd?: string;
  /** One-shot composer text when opening a session from Inbox. */
  composerSeed?: string;
  /** Inbox issue/PR chip shown above the composer. In-memory, one-shot. */
  inboxCard?: InboxComposerCard;
  /** Note chip shown above the composer. In-memory, one-shot. */
  noteCard?: NoteComposerCard;
  /** Handoff chip shown above the composer. In-memory, one-shot. */
  handoffCard?: HandoffComposerCard;
  /** What kind of thread this is; null for subagent children. */
  threadType?: ThreadType | null;
  /** Rule overrides sent with session.create; the server owns them after. */
  threadRules?: ThreadRules | null;
  /** When the draft was minted here, before the server stamps its own times. */
  createdAt?: number;
  /** Plan document (planning) or report (research) path; seeded threads: the source plan. */
  planPath?: string | null;
  /** Parent session for subagent children. */
  parentId?: string | null;
  agentType?: AgentType;
  /** Server-folded tally of the current task list. */
  tasks?: ThreadTasks | null;
  goal?: ThreadGoal | null;
  /** What a working thread is doing right now ("Editing Foo.tsx"). */
  activity?: string | null;
  activityKind?: ActivityKind | null;
  /** Server-side status; `busy` is derived from it. */
  status?: SessionStatus;
  busySince?: number | null;
  pausedAt?: number | null;
  frozenActiveElapsed?: number | null;
  /** Tree-wide flags the server folds over this thread and its children. */
  treeCanContinue?: boolean;
  treeHasLiveWork?: boolean;
  treeHasPaused?: boolean;
  treeFrozenActiveElapsed?: number | null;
  /** The transcript has been fetched from the server at least once. */
  loaded?: boolean;
  archived?: boolean;
  /** Board state folded from the event log (todos, rounds, cost, sources). */
  thread?: ThreadState;
};

export type PendingHarnessSwitch = {
  from: HarnessId;
  fromModel: string;
  fromSettings: Record<string, string>;
  fromProviderSessionId?: string;
};

export const HARNESS_LABEL: Record<HarnessId, string> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor",
  grok: "grok",
  opencode: "opencode",
  pi: "pi",
  omp: "omp",
  fx: "fx",
};

export const HARNESS_TITLE: Record<HarnessId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok Build",
  opencode: "OpenCode",
  pi: "Pi",
  omp: "omp",
  fx: "fx",
};

/** fx and Grok Build ACP reject image and audio blocks. */
export function harnessSupportsAttachments(id: HarnessId): boolean {
  return id !== "fx" && id !== "grok";
}

/** Which server project and workspace a new session is created in. */
export type SessionContext = {
  projectId?: string | null;
  workspaceId?: string | null;
  threadType?: ThreadType;
  /** Per-thread rule overrides a research or orchestration draft starts with. */
  threadRules?: ThreadRules | null;
};

export function newSession(
  harness: HarnessId = "claude",
  cwd = "~",
  model?: string,
  runtimeMode: RuntimeMode = DEFAULT_RUNTIME_MODE,
  modelSettings?: Record<string, string>,
  context: SessionContext = {},
): Session {
  const resolved = resolveModel(harness, model ?? preferredModelId(harness));
  return {
    id: crypto.randomUUID(),
    harness,
    model: resolved.id,
    modelSettings: preferredModelSettings(resolved, modelSettings),
    runtimeMode,
    title: HARNESS_LABEL[harness],
    cwd,
    projectId: context.projectId ?? null,
    workspaceId: context.workspaceId ?? null,
    threadType: context.threadType ?? "chat",
    ...(context.threadRules ? { threadRules: context.threadRules } : {}),
    createdAt: Date.now(),
    blocks: [],
  };
}

/** New conversation using the Providers defaults. */
export function newDefaultSession(
  cwd = "~",
  runtimeMode: RuntimeMode = DEFAULT_RUNTIME_MODE,
  context: SessionContext = {},
): Session {
  const choice = defaultSessionChoice();
  return newSession(choice.harness, cwd, choice.model, runtimeMode, undefined, context);
}

/** First line of a prompt, truncated for the tab strip. */
export function titleFromPrompt(
  prompt: string,
  harness: HarnessId,
  attachments: Attachment[] = [],
): string {
  const line = prompt.trim().split(/\r?\n/)[0]?.trim() ?? "";
  const fromFiles =
    !line && attachments.length > 0
      ? attachments
          .map((file) => file.name)
          .filter(Boolean)
          .slice(0, 3)
          .join(", ")
      : "";
  const seed = line || fromFiles;
  if (!seed) return HARNESS_LABEL[harness];
  const max = 72;
  const short = seed.length > max ? `${seed.slice(0, max - 1)}…` : seed;
  return formatSessionTitle(harness, short);
}

export function formatSessionTitle(harness: HarnessId, title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return HARNESS_LABEL[harness];
  return `${HARNESS_LABEL[harness]} · ${trimmed}`;
}

/** True when the stored title is still a placeholder the LLM may replace. */
export function canReplaceSessionTitle(
  current: string,
  harness: HarnessId,
  seed: string,
): boolean {
  return (
    current === seed ||
    current === HARNESS_LABEL[harness] ||
    current === HARNESS_TITLE[harness]
  );
}

// Cached per blocks array: this runs for every session on every render, and
// an idle session's array keeps its identity, so only the streaming one rescans.
const pendingApprovalCache = new WeakMap<Block[], boolean>();
export function hasPendingApproval(blocks: Block[]): boolean {
  const cached = pendingApprovalCache.get(blocks);
  if (cached !== undefined) return cached;
  const pending = blocks.some((block) => block.approval && !block.approval.decided);
  pendingApprovalCache.set(blocks, pending);
  return pending;
}

/** Title without the harness prefix stored for the tab strip. */
export function sessionDisplayTitle(title: string, harness: HarnessId): string {
  const prefix = `${HARNESS_LABEL[harness]} · `;
  if (title.startsWith(prefix)) return title.slice(prefix.length);
  if (title === HARNESS_LABEL[harness] || title === HARNESS_TITLE[harness]) {
    return "New session";
  }
  return title;
}

/** Working copy the agent and session git UIs should use. */
export function sessionWorkCwd(session: {
  cwd: string;
  worktreeCwd?: string;
}): string {
  return session.worktreeCwd || session.cwd;
}
