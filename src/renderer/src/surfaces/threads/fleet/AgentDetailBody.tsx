import { useMemo, useRef, useState } from "react";
import { HostGlyph } from "../../../chrome/HostGlyph";
import { ArrowUp } from "../../../chrome/icons";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { StatusMark } from "../../../components/ui/status";
import { respondHarnessApproval } from "../../../lib/harness";
import type { OpenFileFn } from "../../../lib/search";
import * as commands from "../../../lib/tcserver/commands";
import { asHarness } from "../../../lib/tcserver/store";
import type { SessionMeta } from "../../../lib/tcserver/types";
import {
  agentStatus,
  isLiveStatus,
  modelLabel,
  useMetaById,
  useSessionById,
  type AgentStatus,
} from "../../../lib/threads/agents";
import { AgentTranscript } from "../../AgentTranscript";
import { AGENT_GLYPHS, useNow } from "../bits";
import { useContextReading } from "./contextCache";
import { AgentNumbersLine } from "./rowBits";
import { agentNumbers, fleetStats, type NumberPart } from "./useFleetModel";

/**
 * What an open subagent shows, inside whatever container holds it (the
 * pane's sheet): the header (title, status, one line of numbers), the live
 * transcript, and a field that steers it while it runs and messages it
 * otherwise. The container owns the entrance, the backdrop, Escape and the
 * close button; the header's Open sits clear of that button.
 */

/** The header: the role glyph and title, the status as on the row but in
 *  full, and the numbers line led by the host, model, effort and branch. */
export function AgentDetailHeader({
  meta,
  status,
  parts,
  branch = null,
  onOpen,
}: {
  meta: Pick<SessionMeta, "title" | "agentType" | "environmentId" | "provider" | "model" | "reasoning">;
  status: AgentStatus;
  parts: NumberPart[];
  /** The agent's checkout when it differs from the parent's. */
  branch?: string | null;
  onOpen?: () => void;
}) {
  const Glyph = AGENT_GLYPHS[meta.agentType];
  return (
    <div className="flex shrink-0 items-start gap-3 py-4 pr-12 pl-5">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          {Glyph ? <Glyph className="size-4 shrink-0 text-muted-foreground" /> : null}
          <h2 className="truncate text-base font-semibold tracking-[-0.01em] text-foreground">{meta.title || "Subagent"}</h2>
        </div>
        <StatusMark
          state={status.state}
          word={status.phrase ? status.detail : true}
          detail={status.phrase ? undefined : status.detail}
          className="mt-0.5 items-start [&_[data-slot=status-detail]]:whitespace-normal [&_[data-slot=status-word]]:whitespace-normal"
        />
        <AgentNumbersLine
          className="mt-1"
          lead={[
            <HostGlyph key="host" environmentId={meta.environmentId} />,
            modelLabel(meta.provider, meta.model),
            meta.reasoning,
            branch,
          ]}
          parts={parts}
        />
      </div>
      {onOpen ? (
        <Button variant="ghost" size="sm" onClick={onOpen}>
          Open
        </Button>
      ) : null}
    </div>
  );
}

/** An open subagent, read from the store: its header, transcript (once the
 *  container's entrance settled, `ready`) and the steer field. */
export function AgentDetailBody({
  agentId,
  parentCwd,
  ready = true,
  onOpenSession,
  onOpenFile,
  onOpenDiff,
  onClose,
}: {
  agentId: string;
  parentCwd: string;
  ready?: boolean;
  onOpenSession?: (sessionId: string) => void;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path?: string) => void;
  onClose: () => void;
}) {
  const meta = useMetaById(agentId);
  const session = useSessionById(agentId);
  const live = isLiveStatus(meta?.status);
  const reading = useContextReading(agentId, live);
  const now = useNow(live);
  const stats = useMemo(() => fleetStats(session, reading), [session, reading]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  if (!meta) return null;
  const harness = asHarness(meta.provider);
  const branch = meta.cwd && meta.cwd !== parentCwd ? (meta.cwd.split("/").filter(Boolean).pop() ?? null) : null;
  const elapsed = live ? now - meta.createdAt : meta.updatedAt - meta.createdAt;
  const parts = agentNumbers(stats, session?.thread?.cost, elapsed);

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
    <div className="flex h-full min-h-0 flex-col">
      <AgentDetailHeader
        meta={meta}
        status={agentStatus(meta, session?.blocks)}
        parts={parts}
        branch={branch}
        onOpen={
          onOpenSession
            ? () => {
                onClose();
                onOpenSession(agentId);
              }
            : undefined
        }
      />
      <div className="relative min-h-60 flex-1">
        {ready ? (
          <div className="absolute inset-0">
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
          </div>
        ) : null}
      </div>
      <form
        className="flex shrink-0 items-center gap-2 border-t border-border px-5 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={live ? "Steer this agent…" : "Message this agent…"}
          disabled={!session}
          className="min-w-0 flex-1"
        />
        <Button type="submit" size="icon" aria-label="Send" disabled={!text.trim() || !session || sending}>
          <ArrowUp />
        </Button>
      </form>
    </div>
  );
}
