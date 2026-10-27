// A9 (notices): a system row, and the handoff divider.
import { TerminalSpinner } from "../../chrome/TerminalSpinner";
import { Shimmer } from "../Shimmer";
import { HARNESS_TITLE, type Block } from "../../lib/session";
import { HarnessIcon } from "../../chrome/HarnessIcon";
import type { OpenFileFn } from "../../lib/search";
import { isNoticeBlock, NoticeRow } from "./NoticeRow";

/** A system row: a typed notice draws through NoticeRow, a plain one is its text. */
export function SystemRow({
  block,
  cwd,
  onOpenFile,
}: {
  block: Block;
  cwd?: string;
  onOpenFile?: OpenFileFn;
}) {
  if (isNoticeBlock(block)) return <NoticeRow block={block} cwd={cwd} onOpenFile={onOpenFile} />;
  return (
    <div className="py-2 text-content/50">
      <pre className="min-w-0 whitespace-pre-wrap break-words">
        {block.text}
      </pre>
    </div>
  );
}

export function HandoffDivider({ block }: { block: Block }) {
  const meta = block.handoff;
  if (!meta) return null;

  const preparing = meta.status === "preparing";
  const label = preparing ? "Preparing a handoff" : HARNESS_TITLE[meta.to];

  return (
    <div className="py-3">
      <div className="flex items-center gap-3">
        <div className="h-px min-w-4 flex-1 bg-content/10" />
        <div
          role="separator"
          aria-label={
            preparing
              ? `Preparing a handoff to ${HARNESS_TITLE[meta.to]}`
              : `Continued with ${label}`
          }
          className="flex max-w-[min(100%,20rem)] items-center gap-1.5 px-1.5 font-sans text-[12px] text-content/50"
        >
          {preparing ? (
            <>
              <TerminalSpinner className="text-content/40" />
              <Shimmer>{label}</Shimmer>
            </>
          ) : (
            <>
              <HarnessIcon harness={meta.to} className="size-3.5 shrink-0" />
            </>
          )}
        </div>
        <div className="h-px min-w-4 flex-1 bg-content/10" />
      </div>
    </div>
  );
}
