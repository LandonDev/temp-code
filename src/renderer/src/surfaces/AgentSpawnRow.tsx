import { useContext } from "react";
import { HarnessIcon } from "../chrome/HarnessIcon";
import { HostGlyph } from "../chrome/HostGlyph";
import type { Block } from "../lib/session";
import { useMetaById } from "../lib/threads/agents";
import { asHarness, sessionStore } from "../lib/tcserver/store";
import { SelectSessionContext } from "./AgentMarkdown";
import { useOpenAgentDetail } from "./agentDetailContext";
import { StatusDot, THREAD_GLYPHS, THREAD_TINTS } from "./threads/bits";

/** The window's environment for a cross-host child id (`<hostId>:<sessionId>`),
 *  before its row is in the store: `local` when the host is this machine. */
export function hostOfAgentId(id: string): string | undefined {
  const host = /^(env_[A-Za-z0-9_-]+):./.exec(id)?.[1];
  return host ? (sessionStore.attachedEnvironmentFor(host) ?? host) : undefined;
}

/**
 * A spawned agent's row, nested under the orchestrator's flow: provider,
 * what it is called, its host's glyph, where it stands. Clicking opens its transcript in
 * this pane's detail panel; a report row reads its status.
 */
export function AgentSpawnRow({ block }: { block: Block }) {
  const agent = block.agent;
  const meta = useMetaById(agent?.id ?? null);
  const openDetail = useOpenAgentDetail();
  const onSelectSession = useContext(SelectSessionContext);
  if (!agent) return null;
  const title = meta?.title || agent.title || "Subagent";
  const report = agent.status !== undefined;
  const status = report ? agent.status : meta?.status;
  const open = openDetail ?? onSelectSession;
  return (
    <div>
      <div className="ml-[7px] flex min-w-0 items-center gap-1.5 border-l border-content/10 py-1 pl-3 font-sans text-sm">
        <span className="grid size-3.5 shrink-0 place-items-center text-content/50">
          {meta ? <HarnessIcon harness={asHarness(meta.provider)} className="size-3.5" /> : null}
        </span>
        <span className="shrink-0 text-content/50">{report ? "Reported" : "Spawned"}</span>
        <button
          type="button"
          disabled={!open}
          title={title}
          className="pressable -my-0.5 min-w-0 truncate rounded-md bg-content/6 px-1 py-0.5 text-left text-content/70 enabled:hover:bg-content/10 enabled:hover:text-content"
          onClick={(event) => {
            event.stopPropagation();
            open?.(agent.id);
          }}
        >
          {title}
        </button>
        <HostGlyph environmentId={meta?.environmentId ?? hostOfAgentId(agent.id)} />
        {status ? (
          <span className="flex shrink-0 items-center gap-1 text-[12px] text-content/40">
            {!report ? <StatusDot status={meta?.status} /> : null}
            {status}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The planning thread's handoff row: the build started from its plan, how
 * (on its own, or by hand), and where that thread stands now. Clicking
 * opens the build in this pane.
 */
export function PlanHandoffRow({ block }: { block: Block }) {
  const handoff = block.planHandoff;
  const meta = useMetaById(handoff?.id ?? null);
  const onSelectSession = useContext(SelectSessionContext);
  if (!handoff) return null;
  const type = meta?.threadType === "orchestration" ? "orchestration" : "implementation";
  const Glyph = THREAD_GLYPHS[type];
  const title = meta?.title || handoff.title;
  return (
    <div>
      <div className="ml-[7px] flex min-w-0 items-center gap-1.5 border-l border-content/10 py-1 pl-3 font-sans text-sm">
        <Glyph className={`size-3.5 shrink-0 ${THREAD_TINTS[type]}`} strokeWidth={1.75} />
        <span className="shrink-0 text-content/50">
          {handoff.how === "auto" ? "Started the build" : "Build started"}
        </span>
        <button
          type="button"
          disabled={!onSelectSession}
          title={title}
          className="pressable -my-0.5 min-w-0 truncate rounded-md bg-content/6 px-1 py-0.5 text-left text-content/70 enabled:hover:bg-content/10 enabled:hover:text-content"
          onClick={(event) => {
            event.stopPropagation();
            onSelectSession?.(handoff.id);
          }}
        >
          {title}
        </button>
        {meta ? (
          <span className="flex shrink-0 items-center gap-1 text-[12px] text-content/40">
            <StatusDot status={meta.status} />
            {meta.archived ? "archived" : meta.status}
          </span>
        ) : null}
      </div>
    </div>
  );
}
