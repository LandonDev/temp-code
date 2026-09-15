import { motion, useReducedMotion } from "motion/react";
import type { OpenFileFn } from "../../../lib/search";
import { useEffect, useMemo, useRef, useState } from "react";
import { EASE_OUT, SPRING_PANEL } from "../../../lib/ease";
import { HarnessIcon } from "../../../chrome/HarnessIcon";
import { ArrowUp, GitBranch, X } from "../../../chrome/icons";
import { respondHarnessApproval } from "../../../lib/harness";
import { isLiveStatus, modelLabel, useMetaById, useSessionById } from "../../../lib/threads/agents";
import * as commands from "../../../lib/tcserver/commands";
import { asHarness } from "../../../lib/tcserver/store";
import { AgentTranscript } from "../../AgentTranscript";
import { StatusDot } from "../bits";
import { AgentStatsLine } from "./AgentRow";
import { useContextReading } from "./contextCache";
import { fleetStats } from "./useFleetModel";

/**
 * A subagent's transcript in a pane-scoped overlay: header with its
 * identity and tallies, the live transcript, and a one-line footer that
 * sends when idle or steers while it runs. "Open" splits it beside the parent.
 *
 * The panel shares `agent-${id}` with its fleet row and morphs out of it.
 * The transcript is a heavy, live-streaming subtree: mounted inside the
 * morphing element it re-layouts on every chunk and wrecks the spring, so
 * it mounts once the morph settles and unmounts before the close morph.
 */
export function AgentDetail({
  agentId,
  parentCwd,
  onClose,
  onOpenSession,
  onOpenFile,
  onOpenDiff,
}: {
  agentId: string;
  parentCwd: string;
  onClose: () => void;
  onOpenSession?: (sessionId: string) => void;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path?: string) => void;
}) {
  const meta = useMetaById(agentId);
  const session = useSessionById(agentId);
  const live = isLiveStatus(meta?.status);
  const reading = useContextReading(agentId, live);
  const stats = useMemo(() => fleetStats(session, reading), [session, reading]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const reduce = useReducedMotion();
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    // onLayoutAnimationComplete can miss (reduced motion, no paired row);
    // never leave the body empty past the morph's length.
    const t = setTimeout(() => setSettled(true), 450);
    return () => clearTimeout(t);
  }, []);

  const close = () => {
    setSettled(false);
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setSettled(false);
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  if (!meta) return null;
  const harness = asHarness(meta.provider);
  const branch = meta.cwd && meta.cwd !== parentCwd ? meta.cwd.split("/").filter(Boolean).pop() : null;
  const cost = session?.thread?.cost;

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
    <div className="absolute inset-0 z-40 flex items-center justify-center p-6">
      <motion.div
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: 0.1, ease: EASE_OUT } }}
        transition={{ duration: 0.12, ease: EASE_OUT }}
        className="absolute inset-0 bg-black/40 glass-surface glass-surface--md"
        onClick={close}
      />
      <motion.div
        layoutId={`agent-${agentId}`}
        transition={SPRING_PANEL}
        onLayoutAnimationComplete={() => setSettled(true)}
        className="relative flex h-full max-h-[640px] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-content/10 bg-background-base/55 shadow-2xl glass-surface glass-surface--md"
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-content/10 px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center gap-2">
              <StatusDot status={meta.status} />
              <span className="truncate text-[13px] font-medium text-content">{meta.title || "Subagent"}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-content/40">
              <span className="inline-flex items-center gap-1">
                <HarnessIcon harness={harness} className="size-3.5" />
                {meta.agentType} · {modelLabel(meta.provider, meta.model)} · {meta.reasoning}
              </span>
              {branch && (
                <span className="inline-flex items-center gap-1">
                  <GitBranch className="size-3.5" strokeWidth={1.75} />
                  {branch}
                </span>
              )}
              <AgentStatsLine stats={stats} />
              {cost !== undefined && <span className="tabular-nums">${cost.toFixed(2)}</span>}
            </div>
          </div>
          {onOpenSession && (
            <button
              type="button"
              onClick={() => {
                close();
                onOpenSession(agentId);
              }}
              className="pressable h-7 shrink-0 rounded-md px-2 text-xs font-medium text-content/50 hover:bg-content/5 hover:text-content"
            >
              Open
            </button>
          )}
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="pressable grid size-7 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/5 hover:text-content"
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>
        <div className="relative min-h-0 flex-1" style={{ minHeight: 240 }}>
          {settled ? (
            <motion.div
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.12, ease: EASE_OUT }}
              className="absolute inset-0"
            >
              <AgentTranscript
                sessionId={agentId}
                blocks={session?.blocks ?? []}
                busy={!!session?.busy}
                visible
                cwd={meta.cwd || parentCwd}
                harness={harness}
                onApproval={(requestId, decision) => respondHarnessApproval(harness, agentId, requestId, decision)}
                onOpenFile={onOpenFile}
                onOpenDiff={onOpenDiff}
              />
            </motion.div>
          ) : null}
        </div>
        <form
          className="flex shrink-0 items-center gap-2 border-t border-content/10 px-4 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={live ? "Steer this agent…" : "Send to this agent…"}
            disabled={!session}
            className="h-7 min-w-0 flex-1 rounded-lg border border-content/10 bg-content/5 px-2 text-[12px] text-content outline-none placeholder:text-content/40 disabled:cursor-default"
          />
          <button
            type="submit"
            disabled={!text.trim() || !session || sending}
            aria-label="Send"
            className="pressable grid size-7 shrink-0 place-items-center rounded-md bg-content text-background-base disabled:opacity-40"
          >
            <ArrowUp className="size-3.5" strokeWidth={2} />
          </button>
        </form>
      </motion.div>
    </div>
  );
}
