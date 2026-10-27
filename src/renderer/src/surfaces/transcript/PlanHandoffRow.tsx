// A9 (notices): the plan's handoff to its build.
import { useContext } from "react";
import type { SessionStatus } from "@server/shared/events";
import { Button } from "../../components/ui/button";
import { StatusMark, type ThreadState } from "../../components/ui/status";
import type { Block } from "../../lib/session";
import { useMetaById } from "../../lib/threads/agents";
import { SelectSessionContext } from "../AgentMarkdown";
import { THREAD_GLYPHS } from "../threads/threadTypes";
import { NoticeLine } from "./NoticeLine";

/** A build's session status in the status vocabulary's words. */
export function buildState(status: SessionStatus): ThreadState {
  switch (status) {
    case "starting":
    case "running":
      return "working";
    case "error":
      return "failed";
    case "idle":
      return "done";
    default:
      return status;
  }
}

/**
 * The planning thread's handoff line: the build started from its plan, how
 * (on its own, or by hand), the build's title to open it in this pane, and
 * where that thread stands now.
 */
export function PlanHandoffRow({ block }: { block: Block }) {
  const handoff = block.planHandoff;
  const meta = useMetaById(handoff?.id ?? null);
  const onSelectSession = useContext(SelectSessionContext);
  if (!handoff) return null;
  const Glyph = THREAD_GLYPHS[meta?.threadType === "orchestration" ? "orchestration" : "implementation"];
  const title = meta?.title || handoff.title;
  return (
    <NoticeLine
      glyph={<Glyph />}
      lead={handoff.how === "auto" ? "Started the build" : "Build started"}
      details={[
        <Button
          variant="link"
          size="xs"
          disabled={!onSelectSession}
          className="h-5 max-w-full px-0 text-[13px] font-normal"
          onClick={() => onSelectSession?.(handoff.id)}
        >
          <span className="truncate">{title}</span>
        </Button>,
        meta ? (
          meta.archived ? (
            <span className="text-xs font-medium text-muted-foreground">Archived</span>
          ) : (
            <StatusMark state={buildState(meta.status)} />
          )
        ) : null,
      ]}
    />
  );
}
