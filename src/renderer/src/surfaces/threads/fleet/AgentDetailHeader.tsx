import { HostGlyph } from "../../../chrome/HostGlyph";
import { Button } from "../../../components/ui/button";
import { StatusMark } from "../../../components/ui/status";
import type { SessionMeta } from "../../../lib/tcserver/types";
import type { AgentStatus } from "../../../lib/threads/agents";
import { AGENT_GLYPHS } from "../threadTypes";
import { ModelLine } from "../ModelMark";
import { AgentNumbersLine } from "./rowBits";
import type { NumberPart } from "./useFleetModel";

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
          <h2 className="truncate text-base font-semibold leading-6 tracking-[-0.01em] text-foreground">{meta.title || "Subagent"}</h2>
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
            <ModelLine key="model" meta={meta} />,
            <HostGlyph key="host" environmentId={meta.environmentId} />,
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
