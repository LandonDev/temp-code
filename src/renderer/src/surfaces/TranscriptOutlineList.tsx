import { memo, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { JumpList, type JumpGroup, type JumpHow } from "../chrome/JumpList";
import { cn } from "../lib/cn";
import { clockTime } from "../lib/duration";
import type { Block } from "../lib/session";
import { threadMentionsInText, useThreadTitles } from "../lib/threadMentions";
import {
  currentEntry,
  dayGroups,
  entryLine,
  entryTime,
  outlineEntries,
  type ReaderStore,
} from "./transcriptOutlineModel";

const NO_STORE = (): (() => void) => () => {};

/**
 * The message list's rows under its chevron (TranscriptOutline.tsx draws the
 * chevron and owns the fold). A lazy chunk of its own (`messageListChunk`),
 * so the first paint carries the chevron alone; a folded list never loads it.
 */
export const TranscriptOutlineList = memo(function TranscriptOutlineList({
  id,
  turns,
  reader,
  readerTurn,
  onJump,
  head,
  now,
  locale,
  folded,
  enter,
}: {
  id: string;
  turns: Block[][];
  reader?: ReaderStore;
  readerTurn: number;
  onJump: (blockId: string, how: JumpHow) => void;
  head?: ReactNode;
  now?: number;
  locale?: string;
  folded: boolean;
  /** Mounted by an unfold: the rows come in as they do after a fold. */
  enter: boolean;
}) {
  const entries = useMemo(() => outlineEntries(turns), [turns]);
  const turn = useSyncExternalStore(
    reader?.subscribe ?? NO_STORE,
    reader ? reader.get : () => readerTurn,
    reader ? reader.get : () => readerTurn,
  );
  const mentions = useMemo(
    () => entries.map((entry) => (entry.block.text.includes("@thread:") ? entry.block.text : "")).join("\n"),
    [entries],
  );
  const titleOf = useThreadTitles(mentions);
  // The titles the lines read, so a renamed thread re-reads them.
  const titles = threadMentionsInText(mentions).map((id) => titleOf(id) ?? "").join("\n");
  const groups = useMemo<JumpGroup[]>(
    () =>
      dayGroups(entries, now ?? Date.now(), locale).map((group) => ({
        label: group.label,
        items: group.entries.map((entry) => {
          const line = entryLine(entry.block.text, entry.block.attachments, titleOf) || "Message";
          const time = entryTime(entry.block);
          const clock = time === undefined ? undefined : clockTime(time, locale);
          return {
            key: entry.id,
            label: line,
            name: clock ? `${line}, ${clock}` : line,
            trailing: clock,
          };
        }),
      })),
    // `titles` stands for what titleOf (the store's reader) answers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, now, locale, titles],
  );
  return (
    <JumpList
      id={id}
      label="Your messages"
      // Folding is an exit: it leaves faster than it comes back. Opacity
      // and translate only, so the compositor runs it; visibility flips at
      // the fold's end, taking the rows out of the tab order and the
      // pointer's way.
      className={cn(
        "min-h-0 transition-[opacity,translate,visibility] duration-(--dur-base) ease-(--ease-out) motion-reduce:transition-[opacity,visibility] motion-reduce:duration-(--dur-fast)",
        enter && "starting:-translate-x-1 starting:opacity-0 motion-reduce:starting:translate-x-0",
        folded && "invisible -translate-x-1 opacity-0 duration-(--dur-fast) motion-reduce:translate-x-0",
      )}
      groups={groups}
      active={currentEntry(entries, turn)}
      onJump={onJump}
      head={head}
    />
  );
});
