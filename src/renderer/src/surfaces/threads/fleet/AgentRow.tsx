import { HostGlyph } from "../../../chrome/HostGlyph";
import { ItemButton } from "../../../components/ui/item";
import { StatusMark } from "../../../components/ui/status";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip";
import { cn } from "../../../lib/cn";
import { marksAtRest } from "../../../lib/threadStripModel";
import type { AgentStatus } from "../../../lib/threads/agents";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { AGENT_GLYPHS } from "../threadTypes";
import { useAgentStatus } from "./useFleetModel";

/**
 * One subagent as one 36px line: its role glyph, the title (at most half
 * the row), the host glyph (two or more hosts), and at the right edge its
 * status: the host's phrase while it works ("Editing HomeView.swift"),
 * otherwise the state's word and what it is about ("Needs you  approve
 * rm -rf build"). At rest (idle, done) the row draws no mark and no word,
 * as rail rows do. The numbers live in the agent's detail; nothing in the
 * row moves.
 */
export function AgentRowView({
  meta,
  status,
  selected = false,
  onOpen,
}: {
  meta: Pick<SessionMeta, "title" | "agentType" | "environmentId">;
  status: AgentStatus;
  selected?: boolean;
  onOpen: () => void;
}) {
  const Glyph = AGENT_GLYPHS[meta.agentType];
  const mark = status.phrase ? (
    <StatusMark state={status.state} word={status.detail} className="min-w-0" />
  ) : (
    <StatusMark state={status.state} detail={status.detail} className="min-w-0" />
  );
  return (
    <ItemButton
      size="xs"
      onClick={onOpen}
      aria-current={selected || undefined}
      className={cn(
        "h-9 flex-nowrap rounded-md px-3 text-left text-[13px] hover:bg-foreground/5",
        selected && "bg-muted hover:bg-muted",
      )}
    >
      {Glyph ? <Glyph className="size-4 shrink-0 text-muted-foreground" /> : null}
      <span className="max-w-1/2 shrink-0 truncate font-medium text-foreground">{meta.title || "Subagent"}</span>
      <HostGlyph environmentId={meta.environmentId} className="shrink-0" />
      {marksAtRest(status.state) ? (
        <span className="ml-auto flex min-w-0 justify-end">
          {status.detail ? (
            <Tooltip>
              <TooltipTrigger render={<span className="flex min-w-0" />}>{mark}</TooltipTrigger>
              <TooltipContent className="max-w-sm">{status.detail}</TooltipContent>
            </Tooltip>
          ) : (
            mark
          )}
        </span>
      ) : null}
    </ItemButton>
  );
}

/** A subagent's row, its status read from the session store. */
export function AgentRow({
  agent,
  onOpen,
  selected = false,
}: {
  agent: SessionMeta;
  onOpen: () => void;
  selected?: boolean;
}) {
  const status = useAgentStatus(agent);
  return <AgentRowView meta={agent} status={status} selected={selected} onOpen={onOpen} />;
}
