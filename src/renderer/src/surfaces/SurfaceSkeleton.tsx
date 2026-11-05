import type { ReactNode } from "react";
import { PAGE_SCROLLER, PAGE_WIDTH } from "../components/page";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import { COLUMN_MAX_CLASS } from "./transcriptOutlineModel";

/**
 * The state kit (docs/DESIGN.md "Loading and empty states"): the fallback a
 * lazy surface (lib/lazyChunk.tsx) shows while its chunk loads, the line a
 * small section shows while it waits on an answer, and the one empty state.
 * A skeleton is the surface's own outline in still blocks, so the frame
 * around it does not jump when the real thing lands; nothing in it moves.
 */
export type SkeletonKind =
  /** A full page with a list column beside its content (Inbox, Notes): the title strip, the list, the detail. */
  | "page"
  /** Search: the title strip, then its result rows. */
  | "search"
  /** A page in the one 672px column under the title strip (Settings, Stats). */
  | "column"
  /** The Accounts page: the column with account rows (a dot, the name over its line, two usage bars, a switch). */
  | "accounts"
  /** A pane of text lines (the editor, release notes, an issue body). */
  | "pane"
  /** A diff: a header strip and two hunks (a diff pane, a PR diff). */
  | "diff"
  /** An edit row's diff in its card: `count` 20px lines (the rows it will show, at most 8), no header, no border. */
  | "diff-rows"
  /** A terminal: the dark host with a prompt block (the terminal, the dev servers pane). */
  | "terminal"
  /** A framed document (an HTML render, an image, a file). */
  | "frame"
  /** A thread while its transcript loads: prompts on the right, answers under them. */
  | "transcript"
  /** A list in a panel or dialog: `count` rows of a title over a line. */
  | "rows";

const PROSE = [72, 48, 88, 36, 64, 56];
/** The Inbox's and Notes' list column at its default width; both views start there. */
export const PAGE_LIST_WIDTH = 280;
/** The 40px title strip every full surface opens with (Search, Inbox, Notes, the pages). */
const STRIP = "h-10 shrink-0 border-b border-border";
/** A Switch's box (components/ui/switch.tsx), for a skeleton standing in for one. */
const SWITCH_SKELETON = "h-[18px] w-8 rounded-full";
const HUNK = [64, 40, 76, 52, 30];
/** The most lines a diff's skeleton draws: past them the fold is already a screen's worth. */
export const DIFF_ROWS_SKELETON_CAP = 8;

/** Lines of `className` height whose widths cycle through `widths` (percent). */
function Lines({ widths, count, className, gap }: { widths: number[]; count: number; className: string; gap: string }) {
  return (
    <div className={`flex flex-col ${gap}`}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className={className} style={{ width: `${widths[i % widths.length]}%` }} />
      ))}
    </div>
  );
}

/**
 * List rows in the shape of what comes: one line (a search hit), a title
 * over a line (an inbox item), or Notes' three-line card (its time, its
 * title, its first words).
 */
function rowsOf(count: number, lines: 1 | 2 | 3): ReactNode {
  return Array.from({ length: count }, (_, i) =>
    lines === 3 ? (
      <div key={i} data-skeleton-row className="flex flex-col px-2 py-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-1 h-3.5 w-40 max-w-full" />
        <Skeleton className="mt-0.5 h-3 w-56 max-w-full" />
      </div>
    ) : lines === 2 ? (
      <div key={i} data-skeleton-row className="flex h-12 flex-col justify-center gap-2 px-3">
        <Skeleton className="h-3 w-40 max-w-full" />
        <Skeleton className="h-2.5 w-56 max-w-full" />
      </div>
    ) : (
      <div key={i} data-skeleton-row className="flex h-7 items-center px-2">
        <Skeleton className="h-3" style={{ width: `${PROSE[i % PROSE.length]}%` }} />
      </div>
    ),
  );
}

function body(kind: SkeletonKind, count: number, lines: 2 | 3): ReactNode {
  switch (kind) {
    case "page":
      // The Inbox's and Notes' frame: the strip, the list column at its
      // default width with two-line rows, then the detail's title and lines.
      return (
        <>
          <div data-skeleton-strip className={STRIP} />
          <div className="flex min-h-0 flex-1">
            <div data-skeleton-list className="flex shrink-0 flex-col border-r border-border px-1 py-1" style={{ width: PAGE_LIST_WIDTH }}>
              {rowsOf(8, 2)}
            </div>
            <div className="min-w-0 flex-1 px-6 pt-6">
              <div className="max-w-2xl">
                <Skeleton className="h-4 w-48" />
                <div className="mt-4">
                  <Lines widths={PROSE} count={6} className="h-3" gap="gap-3" />
                </div>
              </div>
            </div>
          </div>
        </>
      );
    case "search":
      return (
        <>
          <div data-skeleton-strip className={STRIP} />
          <div className="flex flex-col px-1 py-1">{rowsOf(count, 1)}</div>
        </>
      );
    case "column":
    case "accounts":
      // components/page.tsx's frame: the strip, then Page's column in the
      // page's own scroller, with its title, its line and rows in the shape
      // of the page it stands in for.
      return (
        <>
          <div data-skeleton-strip className={STRIP} />
          <div data-skeleton-scroller className={PAGE_SCROLLER}>
            <div data-skeleton-column className={`mx-auto w-full p-6 ${PAGE_WIDTH[kind === "accounts" ? "table" : "column"]}`}>
              <Skeleton className="h-4 w-32" />
              <Skeleton className="mt-2 h-3 w-64 max-w-full" />
              {kind === "accounts" ? (
                <div className="mt-6">
                  <Skeleton className="h-3 w-24" />
                  <div className="mt-2 flex flex-col">
                    {Array.from({ length: count }, (_, i) => (
                      <div key={i} data-skeleton-row className="flex items-center gap-3 py-3">
                        <Skeleton className="size-2 rounded-full" />
                        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                          <Skeleton className="h-3.5 w-32" />
                          <Skeleton className="h-3 w-48 max-w-full" />
                        </div>
                        <Skeleton data-skeleton-bar className="h-6 w-[72px]" />
                        <Skeleton data-skeleton-bar className="h-6 w-[72px]" />
                        <Skeleton data-skeleton-switch className={SWITCH_SKELETON} />
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="mt-6 flex flex-col">
                  {Array.from({ length: count }, (_, i) => (
                    <div key={i} className="flex items-center gap-3 py-3">
                      <Skeleton className="h-3.5 w-32" />
                      <span className="flex-1" />
                      <Skeleton className="h-8 w-40 rounded-lg" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      );
    case "pane":
      return (
        <div className="max-w-2xl p-4">
          <Lines widths={PROSE} count={12} className="h-2.5" gap="gap-2.5" />
        </div>
      );
    case "diff":
      return (
        <>
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
            <Skeleton className="h-3 w-40 max-w-full" />
            <Skeleton className="ms-auto h-3 w-10" />
          </div>
          <div className="flex max-w-2xl flex-col gap-4 p-3">
            {[0, 1].map((hunk) => (
              <div key={hunk} className="flex flex-col gap-2.5">
                <Skeleton className="h-2.5 w-24" />
                <Lines widths={HUNK} count={5} className="h-2.5" gap="gap-2.5" />
              </div>
            ))}
          </div>
        </>
      );
    case "diff-rows":
      // DiffBody's geometry: 4px top and bottom, 20px lines, the code 12px
      // in past the inset, the number column and the mark.
      return Array.from({ length: Math.min(Math.max(count, 1), DIFF_ROWS_SKELETON_CAP) }, (_, i) => (
        <div key={i} data-skeleton-row className="flex h-5 items-center ps-13 pe-3">
          <Skeleton className="h-2.5" style={{ width: `${HUNK[i % HUNK.length]}%` }} />
        </div>
      ));
    case "terminal":
      return (
        <div className="min-h-0 flex-1 p-2">
          <Skeleton className="h-3 w-24" />
        </div>
      );
    case "frame":
      return <Skeleton className="h-full min-h-24 w-full rounded-xl" />;
    case "transcript":
      return (
        <div className={`mx-auto flex w-full min-w-0 ${COLUMN_MAX_CLASS} flex-col gap-8`}>
          {[3, 4, 5].map((lines, i) => (
            <div key={i} className="flex flex-col gap-4">
              <Skeleton className="h-9 w-2/5 self-end rounded-xl" />
              <Lines widths={PROSE} count={lines} className="h-3" gap="gap-3" />
            </div>
          ))}
        </div>
      );
    case "rows":
      return lines === 3 ? <div className="flex flex-col gap-0.5 p-1">{rowsOf(count, 3)}</div> : <div className="flex flex-col gap-1">{rowsOf(count, 2)}</div>;
  }
}

const FRAME: Record<SkeletonKind, string> = {
  page: "flex min-h-0 min-w-0 flex-1 flex-col",
  search: "flex min-h-0 min-w-0 flex-1 flex-col",
  column: "flex min-h-0 min-w-0 flex-1 flex-col",
  accounts: "flex min-h-0 min-w-0 flex-1 flex-col",
  pane: "h-full min-h-0 w-full overflow-hidden",
  diff: "flex h-full min-h-0 w-full flex-col overflow-hidden",
  "diff-rows": "w-full py-1",
  terminal: "monocode-terminal flex h-full min-h-0 w-full flex-col",
  frame: "flex h-full min-h-0 w-full p-3",
  transcript: "h-full min-h-0 w-full overflow-hidden px-4 pt-6",
  rows: "w-full",
};

export function SurfaceSkeleton({
  kind,
  label,
  count = 4,
  lines = 2,
}: {
  kind: SkeletonKind;
  label?: string;
  count?: number;
  /** `rows` only: 3 draws Notes' three-line cards. */
  lines?: 2 | 3;
}) {
  return (
    <div role="status" aria-label={label ?? "Loading"} aria-busy data-surface-skeleton={kind} className={`select-none ${FRAME[kind]}`}>
      {body(kind, count, lines)}
    </div>
  );
}

/** A small section waiting on an answer whose shape is unknown: a spinner
 *  beside its word, centred. */
export function LoadingLine({ label }: { label: string }) {
  return (
    <div role="status" aria-busy className="flex select-none items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
      <Spinner aria-hidden className="size-3.5" />
      <span>{label}</span>
    </div>
  );
}

/** The one empty state of a panel, pane or page: a title, at most one line
 *  and one action. A picker's "no match" is a muted row, never this. */
export function EmptyState({ title, line, action }: { title: string; line?: string; action?: { label: string; onClick: () => void } }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {line ? <EmptyDescription>{line}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? (
        <Button size="sm" variant="secondary" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </Empty>
  );
}
