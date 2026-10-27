import { useContext } from "react";
import { Bot } from "../chrome/icons";
import { HostGlyph } from "../chrome/HostGlyph";
import { StatusMark, STATUS_WORD, type ThreadState } from "../components/ui/status";
import type { Block } from "../lib/session";
import { useMetaById } from "../lib/threads/agents";
import { sessionStore } from "../lib/tcserver/store";
import type { SessionStatus } from "@server/shared/events";
import { SelectSessionContext } from "./AgentMarkdown";
import { useOpenAgentDetail } from "./agentDetailContext";
import { ProviderMark } from "./ToolChips";
import { ActionLine } from "./transcript/ActionLine";
import { buildState } from "./transcript/PlanHandoffRow";

/** The window's environment for a cross-host child id (`<hostId>:<sessionId>`),
 *  before its row is in the store: `local` when the host is this machine. */
export function hostOfAgentId(id: string): string | undefined {
  const host = /^(env_[A-Za-z0-9_-]+):./.exec(id)?.[1];
  return host ? (sessionStore.attachedEnvironmentFor(host) ?? host) : undefined;
}

/** A session status, or a reported one, in the status vocabulary's words. */
function stateOf(status: string | undefined): ThreadState | null {
  if (!status) return null;
  const state = buildState(status as SessionStatus);
  return state in STATUS_WORD ? state : null;
}

/**
 * A spawned agent as one action line: its provider, Spawned or Reported, its
 * title, its host's glyph, where it stands. The line opens its transcript in
 * this pane's detail panel; a report row says the state it reported.
 */
export function AgentSpawnRow({ block }: { block: Block }) {
  const agent = block.agent;
  const meta = useMetaById(agent?.id ?? null);
  const openDetail = useOpenAgentDetail();
  const onSelectSession = useContext(SelectSessionContext);
  if (!agent) return null;
  const title = meta?.title || agent.title || "Subagent";
  const report = agent.status !== undefined;
  const state = stateOf(report ? agent.status : meta?.status);
  const open = openDetail ?? onSelectSession;
  const verb = report ? "Reported" : "Spawned";
  return (
    <ActionLine
      glyph={
        <span className="grid size-3.5 shrink-0 place-items-center text-muted-foreground">
          {meta ? <ProviderMark harness={meta.provider} /> : <Bot className="size-3.5" strokeWidth={1.5} />}
        </span>
      }
      verb={verb}
      object={title}
      label={`${verb} ${title}`}
      onActivate={open ? () => open(agent.id) : undefined}
      trailing={
        <>
          <HostGlyph environmentId={meta?.environmentId ?? hostOfAgentId(agent.id)} />
          {state ? <StatusMark state={state} /> : null}
        </>
      }
    />
  );
}
