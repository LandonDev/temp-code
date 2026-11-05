import { useState } from "react";
import { Input } from "../components/ui/input";
import { ItemButton, ItemActions, ItemContent, ItemMedia, ItemTitle } from "../components/ui/item";
import { timeAgo } from "../lib/duration";
import type { ThreadType } from "../lib/tcserver/types";
import { TypeGlyph } from "../surfaces/threads/TypeGlyph";
import { ArchiveRestore } from "./icons";

const SEARCH_PAST = 6;

/** The hover reveal (DESIGN "Motion values"): waits `--delay-hover`, then
 *  fades `--dur-fast`; keyboard focus shows it at once, leaving is at once. */
const REVEAL =
  "transition-opacity duration-(--dur-fast) ease-(--ease-out) group-hover/item:delay-(--delay-hover) group-focus-visible/item:delay-(--dur-instant) motion-reduce:transition-opacity";

/** A thread the list names: its title, type and age. */
export type ListedThread = { id: string; title: string; type: ThreadType | null; updatedAt: number };

/**
 * The body of the menu's two thread lists, freshest first: Recent threads…
 * (every settled thread of the strip's scope; a row opens it) and Archived
 * threads… (`restore`: Restore on hover puts the thread back and opens it).
 * A row is one 28px line: the tinted type glyph, the title, and its age at
 * the end in `tabular-nums`, where an archived row's Restore takes its place
 * on hover. A filter past six; a filter with no match is one muted row.
 */
export function ThreadListPopover({
  heading,
  threads,
  restore = false,
  onPick,
}: {
  heading: string;
  threads: readonly ListedThread[];
  restore?: boolean;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q ? threads.filter((t) => t.title.toLowerCase().includes(q)) : threads;
  return (
    <>
      <div className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">{heading}</div>
      {threads.length > SEARCH_PAST ? (
        <div className="px-1 pb-1">
          <Input
            autoFocus
            aria-label={`Search ${heading.toLowerCase()} threads`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            className="h-7 text-[13px]"
          />
        </div>
      ) : null}
      <div className="max-h-80 overflow-x-hidden overflow-y-auto">
        {shown.length === 0 ? <p className="flex h-7 items-center px-2 text-[13px] text-muted-foreground">No matches</p> : null}
        {shown.map((thread) => (
          <ItemButton
            key={thread.id}
            size="xs"
            data-listed={thread.id}
            onClick={() => onPick(thread.id)}
            className="py-1 text-left hover:bg-muted"
          >
            <ItemMedia>
              <TypeGlyph type={thread.type} className="size-3.5" />
            </ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle className="w-full truncate font-normal">{thread.title || "Untitled"}</ItemTitle>
            </ItemContent>
            {/* The age and Restore share one cell, so the row never moves when they cross. */}
            <ItemActions className="grid shrink-0 justify-items-end gap-0 text-xs text-muted-foreground">
              <span
                data-listed-age
                className={`tabular-nums [grid-area:1/1]${restore ? ` ${REVEAL} group-hover/item:opacity-0 group-focus-visible/item:opacity-0` : ""}`}
              >
                {timeAgo(thread.updatedAt)}
              </span>
              {restore ? (
                <span
                  data-listed-restore
                  className="flex items-center gap-1 opacity-0 [grid-area:1/1] transition-opacity duration-(--dur-fast) ease-(--ease-out) group-hover/item:opacity-100 group-hover/item:delay-(--delay-hover) group-focus-visible/item:opacity-100 group-focus-visible/item:delay-(--dur-instant) motion-reduce:transition-opacity"
                >
                  <ArchiveRestore className="size-3.5" />
                  Restore
                </span>
              ) : null}
            </ItemActions>
          </ItemButton>
        ))}
      </div>
    </>
  );
}
