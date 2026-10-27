// A9 (notices): a system row, and the handoff divider.
import { Spinner } from "../../components/ui/spinner";
import { TextShimmer } from "../../components/ui/text-shimmer";
import { HARNESS_TITLE, type Block } from "../../lib/session";
import { HarnessIcon } from "../../chrome/HarnessIcon";
import type { OpenFileFn } from "../../lib/search";
import { isNoticeBlock, NoticeRow } from "./NoticeRow";
import { NoticeLine } from "./NoticeLine";

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

/** A handoff to another harness: "Continued with Codex", or the handoff
 *  being prepared. */
export function HandoffDivider({ block }: { block: Block }) {
  const meta = block.handoff;
  if (!meta) return null;
  const to = HARNESS_TITLE[meta.to];
  if (meta.status === "preparing") {
    return (
      <NoticeLine
        role="status"
        aria-label={`Preparing a handoff to ${to}`}
        glyph={<Spinner />}
        lead={<TextShimmer>{`Preparing a handoff to ${to}`}</TextShimmer>}
      />
    );
  }
  return <NoticeLine glyph={<HarnessIcon harness={meta.to} />} lead={`Continued with ${to}`} />;
}
