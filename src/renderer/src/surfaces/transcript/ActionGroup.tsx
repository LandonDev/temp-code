// A7 (turn structure): one run of actions, a line that opens into one list.
import { useMemo } from "react";
import { ChevronRight, Sparkles, type IconComponent } from "../../chrome/icons";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { TextShimmer } from "../../components/ui/text-shimmer";
import type { Block } from "../../lib/session";
import type { OpenFileFn } from "../../lib/search";
import { useLiveEdits } from "../../lib/tcserver/store";
import { useCountUp } from "../../motion/useCountUp";
import { usePersistedOpen } from "../editOpenState";
import { ReconnectChip, reauthOf } from "../ToolChips";
import { useTranscriptSession } from "../transcriptSession";
import {
  actionGroupOf,
  awaitsUser,
  isThinkingBlock,
  isToolBlock,
  thoughtEndTs,
  toolCategory,
  type ActionGroupKind,
} from "../transcriptActivity";
import { actionOf } from "./actionModel";
import { ActivityRow } from "./ActivityRow";
import { Counts } from "./Counts";
import { GLYPH } from "./ToolGlyph";
import type { ApprovalHandler } from "./types";

/** The line's glyph: the row glyph of the run's first call of its dominant kind, so a line and its rows show one icon per act. */
function lineGlyph(blocks: Block[], kind: ActionGroupKind, cwd?: string): IconComponent {
  const lead = blocks.find((b) => isToolBlock(b) && toolCategory(b) === kind);
  return lead ? GLYPH[actionOf(lead, cwd).glyph] : Sparkles;
}

/**
 * Everything the agent did between two paragraphs. One call, with any
 * thoughts around it, or thoughts alone, are their own rows. More is one
 * muted line, led by the glyph of the work it did most
 * ("Created diag.ts, ran a command  +46"), closed until clicked, live or
 * settled; the click is remembered. Open, it is one thin-bordered list with
 * a row per step in order, thinking included. The group owns the box, the
 * dividers and the side padding; each row owns its slot.
 */
export function ActionGroup({
  blocks,
  cwd,
  live = false,
  onApproval,
  onOpenFile,
  onOpenDiff,
}: {
  blocks: Block[];
  cwd?: string;
  live?: boolean;
  onApproval?: ApprovalHandler;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path: string) => void;
}) {
  const sessionId = useTranscriptSession() ?? "";
  // Only the live run reads the server's live diffs; a settled one has its counts.
  const liveEdits = useLiveEdits(live ? sessionId : "");
  const group = useMemo(
    () => actionGroupOf(blocks, { cwd, live, liveEdits: live ? liveEdits : undefined }),
    [blocks, cwd, live, liveEdits],
  );
  const [saved, setSaved] = usePersistedOpen(`${sessionId}:a:${blocks[0]?.id}`);
  const adds = useCountUp(group.adds, live);
  const dels = useCountUp(group.dels, live);

  const rows = blocks.map((block, index) => (
    <ActivityRow
      key={block.id}
      block={block}
      cwd={cwd}
      live={live}
      expanded
      endTs={isThinkingBlock(block) ? thoughtEndTs(blocks, index) : undefined}
      onApproval={onApproval}
      onOpenFile={onOpenFile}
      onOpenDiff={onOpenDiff}
    />
  ));
  if (group.lone) return <div className="flex min-w-0 flex-col">{rows}</div>;

  // A step still waiting on the person keeps the list open whatever was clicked.
  const open = blocks.some(awaitsUser) || saved === true;
  const reauth = open ? undefined : reauthOf(blocks);
  const Glyph = lineGlyph(blocks, group.kind, cwd);

  return (
    <Collapsible open={open} onOpenChange={setSaved} className="flex min-w-0 flex-col">
      <div className="flex min-w-0 items-center gap-2">
        <CollapsibleTrigger
          className="group/line flex min-h-8 w-fit min-w-0 items-center gap-2 rounded-md font-sans text-[14px] leading-6 text-muted-foreground transition-colors duration-(--dur-fast) hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          <span data-kind={group.kind} className="flex shrink-0">
            <Glyph className="size-3.5" strokeWidth={1.5} aria-hidden />
          </span>
          {live ? (
            <TextShimmer className="min-w-0 truncate">{group.phrase}</TextShimmer>
          ) : (
            <span className="min-w-0 truncate">{group.phrase}</span>
          )}
          <Counts added={adds} removed={dels} failed={group.failed} />
          <ChevronRight
            aria-hidden
            className={`size-3 shrink-0 transition-transform duration-(--dur-fast) motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
            strokeWidth={1.5}
          />
        </CollapsibleTrigger>
        {reauth ? <ReconnectChip reauth={reauth} /> : null}
      </div>
      <CollapsibleContent>
        <div className="mt-1 divide-y divide-border rounded-lg border border-border bg-card">
          {rows.map((row) => (
            <div key={row.key} className="min-w-0 px-3">
              {row}
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
