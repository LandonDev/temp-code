import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUp, MessageSquare, Pause, Play, Square, X } from "../../../chrome/icons";
import { ArchiveThreadDialog } from "../../../chrome/ThreadResourcesDialog";
import { EASE_OUT_CSS } from "../../../lib/ease";
import type { Block } from "../../../lib/session";
import * as commands from "../../../lib/tcserver/commands";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { hasRunningTurn } from "../../../lib/threadBatch";
import { loadThreadResources, useThreadResources } from "../../../lib/threadResources";
import { TONE_CLASS, type AgentTone } from "../../../lib/threads/agents";
import { duration } from "../bits";
import { AgentStatsLine, ModelLine, StatusGlyph } from "../fleet/rowBits";
import { useAgentModel } from "../fleet/useFleetModel";
import { branchOf, clockTime, typeWord } from "./useMasterModel";

/**
 * One child of the batch as a row (docs/LAYOUT.md "Master"): the fleet
 * row's look with the child's type and host after its title, what it is
 * doing on the second line, its tallies on the third, and the model with
 * the elapsed time at the right. Hover trades the right column for the
 * actions; a click unfolds the row in place to its last lines and a
 * message field; ⌘↩ opens the child as a tab.
 */

const UNFOLD_MS = 200;
const FEED_LINES = 4;

/** The last `limit` things the child did, newest last: a tool with its
 *  detail, the child's own words, an error. */
export function feedLines(blocks: readonly Block[], limit = FEED_LINES): { key: string; head: string; text: string }[] {
  const out: { key: string; head: string; text: string }[] = [];
  for (let i = blocks.length - 1; i >= 0 && out.length < limit; i--) {
    const b = blocks[i];
    if (b.role === "tool") {
      const name = b.tool?.title ?? b.tool?.name ?? "tool";
      const detail = b.tool?.detail || firstLine(toolInput(b.tool?.input));
      out.push({ key: b.id, head: name, text: detail });
    } else if (b.role === "assistant" && b.text.trim()) {
      out.push({ key: b.id, head: "", text: firstLine(b.text) });
    } else if (b.role === "system" && b.id.startsWith("err:") && b.text.trim()) {
      out.push({ key: b.id, head: "error", text: firstLine(b.text) });
    }
  }
  return out.reverse();
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

function toolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "description", "query"]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

/** The row's second line: the scheduler's or the harness's `activity` while
 *  the child is queued or working, the question or the failure while it
 *  needs the person, nothing once it is done. */
export function whatLine(
  meta: Pick<SessionMeta, "status" | "activity">,
  line: { text: string; tone: AgentTone },
): { text: string; tone: AgentTone } | null {
  switch (meta.status) {
    case "waiting":
    case "error":
      return line.text ? line : null;
    case "paused":
      return { text: "Paused", tone: "muted" };
    case "queued":
    case "starting":
    case "running":
    case "watching":
      return { text: meta.activity?.trim() || line.text, tone: "muted" };
    default:
      return null;
  }
}

export function MasterRow({
  child,
  masterCwd,
  now,
  fleetSize,
  landed,
  hostName,
  open,
  onToggle,
  onOpenSession,
}: {
  child: SessionMeta;
  masterCwd: string;
  now: number;
  fleetSize: number;
  /** The batch marked this child's branch landed. */
  landed: boolean;
  /** The child's host when it is not the master's; null otherwise. */
  hostName: string | null;
  open: boolean;
  onToggle: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { session, live, idle, line, stats, elapsed } = useAgentModel(child, now, fleetSize);
  const what = whatLine(child, line);
  const branch = branchOf(child, masterCwd);
  const queued = child.status === "queued";
  const dim = idle || queued;
  const [archiving, setArchiving] = useState(false);
  const resources = useThreadResources(archiving ? child.id : null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const [wantFocus, setWantFocus] = useState(false);

  useEffect(() => {
    if (open && wantFocus) {
      fieldRef.current?.focus();
      setWantFocus(false);
    }
  }, [open, wantFocus]);

  const message = () => {
    setWantFocus(true);
    if (!open) onToggle();
  };
  const openArchive = () => {
    void loadThreadResources(child.id);
    setArchiving(true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && e.metaKey && onOpenSession) {
      e.preventDefault();
      onOpenSession(child.id);
    }
  };

  const actions: ReactNode[] = [];
  if (queued) {
    // Start now goes past the host's cap and `after`; Remove from queue is the
    // fleet switches' Stop on a queued root (it archives; lib/threadBatch.ts).
    actions.push(<Action key="start" title="Start now" icon={Play} onClick={() => void commands.startNow(child.id)} />);
    actions.push(
      <Action
        key="remove"
        title="Remove from queue"
        icon={X}
        onClick={() => void commands.sessionBatch(child.environmentId, "stop", [child.id])}
      />,
    );
  } else {
    actions.push(<Action key="message" title="Message" icon={MessageSquare} onClick={message} />);
    if (hasRunningTurn(child)) {
      actions.push(<Action key="pause" title="Pause" icon={Pause} onClick={() => void commands.pause(child.id)} />);
      actions.push(<Action key="stop" title="Stop" icon={Square} onClick={() => void commands.interrupt(child.id)} />);
    } else if (child.status === "paused" || child.status === "stopped") {
      actions.push(<Action key="resume" title="Resume" icon={Play} onClick={() => void commands.resume(child.id)} />);
    }
    actions.push(<Action key="remove" title="Remove" icon={X} onClick={openArchive} />);
  }

  return (
    <div
      className={`group relative rounded-lg transition-colors hover:bg-content/5 ${open ? "bg-content/5" : ""}`}
      data-open={open || undefined}
      data-status={child.status}
    >
      <button
        type="button"
        onClick={onToggle}
        onKeyDown={onKey}
        aria-expanded={open}
        className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left"
      >
        <span className="flex h-[18px] w-4 shrink-0 items-center justify-center">
          <StatusGlyph status={child.status} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5 leading-[18px]">
            <span className={`truncate text-[13px] font-medium ${dim ? "text-content/50" : "text-content"}`}>
              {child.title || "Untitled"}
            </span>
            {typeWord(child) ? <span className="shrink-0 text-xs text-content/40">{typeWord(child)}</span> : null}
            {hostName ? <span className="shrink-0 text-xs text-content/40">· {hostName}</span> : null}
          </span>
          {what ? (
            <span className={`truncate text-xs leading-4 ${TONE_CLASS[what.tone]}`}>{what.text}</span>
          ) : live ? (
            <span className="text-xs leading-4 text-content/40 italic">starting up</span>
          ) : null}
          <AgentStatsLine
            stats={stats}
            tail={[branch, landed ? `landed ${clockTime(child.updatedAt)}` : null]}
            className="text-[11px]"
          />
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5 pt-px text-xs tabular-nums text-content/40 transition-opacity group-hover:opacity-0">
          <ModelLine meta={child} className="text-content/50" />
          {!queued && elapsed > 2000 ? <span>{duration(elapsed)}</span> : null}
        </span>
      </button>

      <div
        data-actions
        className="pointer-events-none absolute top-1.5 right-2 flex gap-0.5 rounded-md border border-content/10 bg-background-base p-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
      >
        {actions}
      </div>

      <Unfold open={open}>
        <div className="flex flex-col gap-1.5 border-t border-content/10 px-3 pt-2 pb-2.5 pl-[38px]">
          <Feed blocks={session?.blocks ?? []} loaded={!!session?.loaded} />
          <MessageField
            inputRef={fieldRef}
            session={session}
            live={live}
            canOpen={!!onOpenSession}
            onOpen={() => onOpenSession?.(child.id)}
          />
        </div>
      </Unfold>

      {archiving ? (
        <ArchiveThreadDialog
          sessionId={child.id}
          title={child.title || "this thread"}
          resources={resources}
          onCancel={() => setArchiving(false)}
          onArchived={() => setArchiving(false)}
        />
      ) : null}
    </div>
  );
}

function Action({
  title,
  icon: Icon,
  onClick,
}: {
  title: string;
  icon: typeof X;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="pressable grid h-5 w-[22px] place-items-center rounded text-content/50 hover:bg-content/8 hover:text-content"
    >
      <Icon className="size-3" strokeWidth={1.5} />
    </button>
  );
}

/** The unfold: a grid row tweening 0fr → 1fr with the body fading in, a
 *  CSS transition so a second click mid-way turns it round from where it
 *  is. The body stays mounted while closed so its text is ready. */
function Unfold({ open, children }: { open: boolean; children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <div
      className="grid"
      style={{
        gridTemplateRows: open ? "1fr" : "0fr",
        transition: reduce ? "none" : `grid-template-rows ${UNFOLD_MS}ms ${EASE_OUT_CSS}`,
      }}
    >
      <div
        inert={!open}
        className="min-h-0 overflow-hidden"
        style={{
          opacity: open ? 1 : 0,
          transition: reduce ? "none" : `opacity ${open ? 160 : 100}ms ${EASE_OUT_CSS}`,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function Feed({ blocks, loaded }: { blocks: readonly Block[]; loaded: boolean }) {
  const lines = feedLines(blocks);
  if (lines.length === 0) {
    return <p className="text-xs text-content/40">{loaded ? "Nothing yet" : "Loading…"}</p>;
  }
  return (
    <ul className="flex flex-col gap-0.5 text-xs text-content/50">
      {lines.map((l) => (
        <li key={l.key} className="flex min-w-0 items-baseline gap-2">
          {l.head ? <span className="shrink-0 text-content/80">{l.head}</span> : null}
          <span className="min-w-0 truncate">{l.text}</span>
        </li>
      ))}
    </ul>
  );
}

function MessageField({
  inputRef,
  session,
  live,
  canOpen,
  onOpen,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  session: ReturnType<typeof useAgentModel>["session"];
  live: boolean;
  canOpen: boolean;
  onOpen: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const submit = async () => {
    const body = text.trim();
    if (!body || !session || sending) return;
    setSending(true);
    setText("");
    try {
      if (live) await commands.steer(session, body);
      else await commands.send(session, body);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };
  return (
    <form
      className="flex h-7 items-center gap-2 rounded-md border border-content/10 pr-1 pl-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.metaKey && canOpen) {
            e.preventDefault();
            onOpen();
          }
        }}
        placeholder="Message this thread…"
        aria-label="Message this thread"
        disabled={!session}
        className="h-full min-w-0 flex-1 bg-transparent text-xs text-content outline-none placeholder:text-content/40 disabled:cursor-default"
      />
      {canOpen ? <span className="shrink-0 text-[11px] text-content/30">⌘↩ open</span> : null}
      <button
        type="submit"
        disabled={!text.trim() || !session || sending}
        aria-label="Send"
        className="pressable grid size-5 shrink-0 place-items-center rounded bg-content text-background-base disabled:opacity-30"
      >
        <ArrowUp className="size-3" strokeWidth={2} />
      </button>
    </form>
  );
}
