import { useMemo, useRef, useState } from "react";
import { ArrowUp } from "../../../chrome/icons";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { respondHarnessApproval } from "../../../lib/harness";
import type { OpenFileFn } from "../../../lib/search";
import * as commands from "../../../lib/tcserver/commands";
import { asHarness } from "../../../lib/tcserver/store";
import {
  agentStatus,
  isLiveStatus,
  useMetaById,
  useSessionById,
} from "../../../lib/threads/agents";
import { AgentTranscript } from "../../AgentTranscript";
import { AgentDetailHeader } from "./AgentDetailHeader";
import { SurfaceSkeleton } from "../../SurfaceSkeleton";
import { useContextReading } from "../../../lib/contextCache";
import { agentNumbers, fleetStats } from "./useFleetModel";

/**
 * What an open subagent shows, inside whatever container holds it (the
 * pane's sheet): the header (title, status, one line of numbers), the live
 * transcript, and a field that steers it while it runs and messages it
 * otherwise. The container owns the entrance, the backdrop, Escape and the
 * close button; the header's Open sits clear of that button.
 */

/** An open subagent, read from the store: its header, transcript (once the
 *  container's entrance settled, `ready`) and the steer field. */
export function AgentDetailBody({
  agentId,
  parentCwd,
  ready = true,
  onOpenSession,
  onOpenFile,
  onOpenDiff,
}: {
  agentId: string;
  parentCwd: string;
  ready?: boolean;
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
  // A send that failed keeps the person's words in the field and says why under it.
  const [failure, setFailure] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  if (!meta) return null;
  const harness = asHarness(meta.provider);
  const branch = meta.cwd && meta.cwd !== parentCwd ? (meta.cwd.split("/").filter(Boolean).pop() ?? null) : null;
  const parts = agentNumbers(stats, session?.thread?.cost);

  const submit = async () => {
    const body = text.trim();
    if (!body || !session || sending) return;
    setSending(true);
    setFailure(null);
    try {
      if (live) await commands.steer(session, body);
      else await commands.send(session, body);
      setText((now) => (now.trim() === body ? "" : now));
    } catch (error) {
      setFailure(`Couldn't ${live ? "steer" : "send"}: ${error instanceof Error ? error.message : String(error)}`);
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
        // The caller closes with the open (AgentDetail's closeThen).
        onOpen={onOpenSession ? () => onOpenSession(agentId) : undefined}
      />
      <div className="relative min-h-60 flex-1">
        {/* While the sheet slides in, the transcript's skeleton holds its place. */}
        {!ready ? (
          <div className="absolute inset-0" data-agent-loading>
            <SurfaceSkeleton kind="transcript" label="Loading the agent" />
          </div>
        ) : (
          <div className="absolute inset-0">
            <AgentTranscript
              sessionId={agentId}
              turn={session ?? null}
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
        )}
      </div>
      <form
        className="flex shrink-0 flex-col gap-1 border-t border-border px-5 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-center gap-2">
          <Input
            ref={inputRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setFailure(null);
            }}
            placeholder={live ? "Steer this agent…" : "Message this agent…"}
            disabled={!session}
            aria-invalid={failure ? true : undefined}
            className="min-w-0 flex-1"
          />
          <Button type="submit" size="icon" aria-label="Send" disabled={!text.trim() || !session || sending}>
            <ArrowUp />
          </Button>
        </div>
        {failure ? (
          <p role="alert" className="text-xs text-destructive">
            {failure}
          </p>
        ) : null}
      </form>
    </div>
  );
}
