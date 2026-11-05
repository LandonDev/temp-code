import { ItemButton, ItemContent, ItemMedia, ItemTitle } from "../components/ui/item";
import { useEnvironments } from "../lib/connection";
import { useSessionMeta } from "../lib/tcserver/store";
import { TypeGlyph } from "../surfaces/threads/TypeGlyph";
import { decisionsLabel, type AwayDecidedThread } from "./awayReturnModel";
import { HostGlyph } from "./HostGlyph";
import { Modal, useModalClose } from "./Modal";

type Props = {
  threads: readonly AwayDecidedThread[];
  /** Opens a thread; the dialog closes behind it. */
  onOpen: (sessionId: string, environmentId: string) => void;
  onClose: () => void;
};

/**
 * "Decided while you were away": one row per thread that decided without the
 * person (the return toast's Review, chrome/AwayReturn.tsx), most decisions
 * first. A row is the thread's type glyph, its title, its host with two or
 * more hosts, and the count. A click opens the thread.
 */
export function AwayReviewDialog({ threads, onOpen, onClose }: Props) {
  const hosts = useEnvironments().length;
  const rows = [...threads].sort((a, b) => b.count - a.count);
  return (
    <Modal title="Decided while you were away" size="sm" onClose={onClose}>
      <div className="flex flex-col px-3 pt-3 pb-3">
        {rows.map((thread) => (
          <AwayReviewRow key={`${thread.environmentId}:${thread.sessionId}`} thread={thread} host={hosts >= 2} onOpen={onOpen} onClose={onClose} />
        ))}
      </div>
    </Modal>
  );
}

function AwayReviewRow({ thread, host, onOpen, onClose }: { thread: AwayDecidedThread; host: boolean } & Omit<Props, "threads">) {
  const meta = useSessionMeta(thread.sessionId);
  const close = useModalClose();
  return (
    <ItemButton
      size="xs"
      data-away-thread={thread.sessionId}
      onClick={() => {
        onOpen(thread.sessionId, thread.environmentId);
        // The dialog plays its exit, then unmounts.
        if (close) close(onClose);
        else onClose();
      }}
      className="text-left hover:bg-muted"
    >
      <ItemMedia>
        <TypeGlyph type={meta?.threadType} className="size-3.5" />
      </ItemMedia>
      <ItemContent className="min-w-0 flex-row items-center gap-1">
        <ItemTitle className="min-w-0 truncate font-normal">{meta?.title || "Untitled"}</ItemTitle>
        {host ? <HostGlyph environmentId={thread.environmentId} /> : null}
      </ItemContent>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{decisionsLabel(thread.count)}</span>
    </ItemButton>
  );
}
