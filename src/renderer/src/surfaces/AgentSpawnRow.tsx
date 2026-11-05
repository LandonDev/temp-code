import { useContext } from "react";
import { Bot } from "../chrome/icons";
import { HostGlyph } from "../chrome/HostGlyph";
import { StatusMark, STATUS_WORD, type ThreadState } from "../components/ui/status";
import { useAgentTitle } from "../lib/agentTitle";
import type { Block } from "../lib/session";
import { useMetaById } from "../lib/threads/agents";
import { sessionStore } from "../lib/tcserver/store";
import type { SessionStatus } from "@server/shared/events";
import { bareAgentId } from "@shared/watch";
import { SelectSessionContext } from "./AgentMarkdown";
import { useOpenAgentDetail } from "./agentDetailContext";
import { ProviderMark } from "./ToolChips";
import { ActionLine } from "./transcript/ActionLine";
import { useSpawnedName } from "./transcript/groupHand";
import { GLYPH_SLOT } from "./transcript/stepLine";
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

/** The agent's row in the store: by its bare session id, else the id as given. */
function useAgentMeta(id: string) {
  const bare = useMetaById(bareAgentId(id));
  const whole = useMetaById(id);
  return bare ?? whole;
}

/** What an agent's settle says it did, by the status it settled in. */
export function reportVerb(status: string | undefined): string {
  switch (status) {
    case "failed":
    case "error":
    case "blocked":
      return "Failed";
    case "waiting":
      return "Needs you";
    case "stopped":
      return "Stopped";
    case "paused":
      return "Paused";
    default:
      return "Finished";
  }
}

/** The agent's detail in this pane, else the thread itself. */
function useAgentOpener(): ((id: string) => void) | undefined {
  const openDetail = useOpenAgentDetail();
  const onSelectSession = useContext(SelectSessionContext);
  return openDetail ?? onSelectSession ?? undefined;
}

/**
 * An agent that settled, as one step of the run: its state's glyph, what
 * it did ("Finished", "Failed", "Needs you", "Stopped", "Paused") and its
 * title. A report row and each agent a wait returned on draw it. It opens
 * the agent's transcript; the batch's own report reads "the batch" and
 * opens nothing, since it names this thread.
 */
export function AgentStepRow({
  id,
  status,
  stamped,
  batch = false,
}: {
  id: string;
  status: string;
  /** The title the report row carries, for an agent the store has not listed. */
  stamped?: string;
  batch?: boolean;
}) {
  const open = useAgentOpener();
  const spawn = useSpawnedName(id);
  const name = useAgentTitle(batch ? null : id, { stamped, inputTitle: spawn?.title, task: spawn?.task });
  const verb = reportVerb(status);
  const title = batch ? "the batch" : name.title;
  return (
    <ActionLine
      glyph={<StatusMark state={stateOf(status) ?? "done"} word={false} still className="me-1" />}
      verb={verb}
      object={title}
      title={batch ? undefined : name.full}
      label={`${verb} ${title}`}
      onActivate={!batch && open ? () => open(id) : undefined}
    />
  );
}

/**
 * One child of a spawn as one line: its provider, Spawned, its title, its
 * host's glyph and where it stands. A batch spawn draws one per child, as
 * an edit draws one row per file; an older log's spawn with no call to
 * stand on draws one too. The line opens the agent's transcript.
 */
export function SpawnChildRow({ id, inputTitle, task }: { id: string; inputTitle?: string; task?: string }) {
  const meta = useAgentMeta(id);
  const open = useAgentOpener();
  const name = useAgentTitle(id, { inputTitle, task });
  return (
    <ActionLine
      glyph={
        <span className={GLYPH_SLOT}>{meta ? <ProviderMark harness={meta.provider} /> : <Bot className="size-3.5" />}</span>
      }
      verb="Spawned"
      object={name.title}
      title={name.full}
      label={`Spawned ${name.title}`}
      onActivate={open ? () => open(id) : undefined}
      trailing={<SpawnedAgentMarks id={id} />}
    />
  );
}

/** A host row about one agent: a report (its settle) or an older log's spawn. */
export function AgentSpawnRow({ block }: { block: Block }) {
  const agent = block.agent;
  if (!agent) return null;
  if (agent.status !== undefined) {
    return <AgentStepRow id={agent.id} status={agent.status} stamped={agent.title} batch={agent.batch} />;
  }
  return <SpawnChildRow id={agent.id} inputTitle={agent.title} />;
}

/** What a spawn row says about one child: its host's glyph and where it
 *  stands, working as a dot (the group's own line already moves). */
export function SpawnedAgentMarks({ id }: { id: string }) {
  const meta = useAgentMeta(id);
  const state = stateOf(meta?.status);
  return (
    <>
      <HostGlyph environmentId={meta?.environmentId ?? hostOfAgentId(id)} />
      {state ? <StatusMark state={state} still /> : null}
    </>
  );
}
