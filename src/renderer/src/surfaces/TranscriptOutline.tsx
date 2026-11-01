import { memo, useMemo, useSyncExternalStore } from "react";
import { Button } from "../components/ui/button";
import { JumpList, type JumpGroup, type JumpHow } from "../chrome/JumpList";
import type { Block } from "../lib/session";
import { threadMentionsInText, useThreadTitles } from "../lib/threadMentions";
import {
  currentEntry,
  dayGroups,
  entryClock,
  entryLine,
  entryTime,
  outlineEntries,
  type ReaderStore,
} from "./transcriptOutline";

const NO_STORE = (): (() => void) => () => {};

/**
 * The transcript's left side: the person's own messages, one line each with
 * its clock time, the one being read marked, a click or Enter landing on it
 * (transcriptOutline.ts has the rules; AgentTranscript places it).
 */
export const TranscriptOutline = memo(function TranscriptOutline({
  turns,
  reader,
  readerTurn = 0,
  onJump,
  hasOlder = false,
  onLoadEarlier,
  now,
  locale,
  className,
}: {
  turns: Block[][];
  /** The reader's turn, written by the scroll engine; a scroll renders the
   *  list alone. */
  reader?: ReaderStore;
  /** The reader's turn when there is no store (a static render). */
  readerTurn?: number;
  onJump: (blockId: string, how: JumpHow) => void;
  /** Older history the host has not sent yet. */
  hasOlder?: boolean;
  onLoadEarlier?: () => void;
  /** Today, for the day labels; defaults to now. */
  now?: number;
  locale?: string;
  className?: string;
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
          const clock = time === undefined ? undefined : entryClock(time, locale);
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
      label="Your messages"
      className={className}
      groups={groups}
      active={currentEntry(entries, turn)}
      onJump={onJump}
      head={
        hasOlder && onLoadEarlier ? (
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start font-normal text-muted-foreground"
            onClick={onLoadEarlier}
          >
            Earlier messages
          </Button>
        ) : undefined
      }
    />
  );
});
