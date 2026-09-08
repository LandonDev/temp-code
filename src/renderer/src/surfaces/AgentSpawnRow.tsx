import { useContext } from "react";
import { HarnessIcon } from "../chrome/HarnessIcon";
import type { Block } from "../lib/session";
import { useMetaById } from "../lib/threads/agents";
import { asHarness } from "../lib/tcserver/store";
import { SelectSessionContext } from "./AgentMarkdown";
import { useOpenAgentDetail } from "./agentDetailContext";
import { StatusDot } from "./threads/bits";

/**
 * A spawned agent's row, nested under the orchestrator's flow: provider,
 * what it is called, where it stands. Clicking opens its transcript in
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
    <div className="px-4">
      <div className="ml-[7px] flex min-w-0 items-center gap-1.5 border-l border-content/12 py-1 pl-3 font-sans text-sm">
        <span className="grid size-3.5 shrink-0 place-items-center text-content/60">
          {meta ? <HarnessIcon harness={asHarness(meta.provider)} className="size-3" /> : null}
        </span>
        <span className="shrink-0 text-content/50">{report ? "Reported" : "Spawned"}</span>
        <button
          type="button"
          disabled={!open}
          title={title}
          className="-my-0.5 min-w-0 truncate rounded bg-content/6 px-1 py-0.5 text-left text-content/70 enabled:hover:bg-content/10 enabled:hover:text-content"
          onClick={(event) => {
            event.stopPropagation();
            open?.(agent.id);
          }}
        >
          {title}
        </button>
        {status ? (
          <span className="flex shrink-0 items-center gap-1 text-[12px] text-content/45">
            {!report ? <StatusDot status={meta?.status} /> : null}
            {status}
          </span>
        ) : null}
      </div>
    </div>
  );
}
