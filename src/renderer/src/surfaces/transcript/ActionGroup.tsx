// A7 (turn structure): one run of actions, a line that opens into one list.
import { useMemo } from "react";
import { ChevronRight, PenLine, Search, Sparkles, Terminal, Wrench } from "../../chrome/icons";
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
  thoughtEndTs,
  type ActionGroupKind,
} from "../transcriptActivity";
import { ActivityRow } from "./ActivityRow";
import type { ApprovalHandler } from "./types";

const GLYPH: Record<ActionGroupKind, typeof PenLine> = {
  edit: PenLine,
  run: Terminal,
  research: Search,
  other: Wrench,
  think: Sparkles,
};

/**
 * Everything the agent did between two paragraphs. One call is that call's
 * own row. More is one muted line, led by the glyph of the work it did most
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

  if (group.lone) {
    return (
      <ActivityRow
        block={group.lone}
        cwd={cwd}
        live={live}
        expanded
        onApproval={onApproval}
        onOpenFile={onOpenFile}
        onOpenDiff={onOpenDiff}
      />
    );
  }

  // A step still waiting on the person keeps the list open whatever was clicked.
  const open = blocks.some(awaitsUser) || saved === true;
  const reauth = open ? undefined : reauthOf(blocks);
  const Glyph = GLYPH[group.kind];

  return (
    <Collapsible open={open} onOpenChange={setSaved} className="flex min-w-0 flex-col">
      <div className="flex min-w-0 items-center gap-2">
        <CollapsibleTrigger
          className="group/line flex min-h-8 w-fit min-w-0 items-center gap-2 rounded-md font-sans text-[14px] leading-6 text-muted-foreground transition-colors duration-(--dur-fast) hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none"
        >
          <span data-kind={group.kind} className="flex shrink-0">
            <Glyph className="size-3.5" strokeWidth={1.5} aria-hidden />
          </span>
          {live ? (
            <TextShimmer className="min-w-0 truncate">{group.phrase}</TextShimmer>
          ) : (
            <span className="min-w-0 truncate">{group.phrase}</span>
          )}
          {adds > 0 || dels > 0 || group.failed > 0 ? (
            <span className="flex shrink-0 items-center gap-2 tabular-nums">
              {adds > 0 ? <span className="text-success">+{adds}</span> : null}
              {dels > 0 ? <span className="text-destructive">−{dels}</span> : null}
              {group.failed > 0 ? <span className="text-destructive">{group.failed} failed</span> : null}
            </span>
          ) : null}
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
          {blocks.map((block, index) => (
            <div key={block.id} className="min-w-0 px-3">
              <ActivityRow
                block={block}
                cwd={cwd}
                live={live}
                expanded
                endTs={isThinkingBlock(block) ? thoughtEndTs(blocks, index) : undefined}
                onApproval={onApproval}
                onOpenFile={onOpenFile}
                onOpenDiff={onOpenDiff}
              />
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
