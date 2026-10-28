import type { ReactNode } from "react";
import { PAGE_SCROLLER } from "../components/page";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";

/**
 * The state kit (docs/DESIGN.md "Loading and empty states"): the fallback a
 * lazy surface (lib/lazyChunk.tsx) shows while its chunk loads, the line a
 * small section shows while it waits on an answer, and the one empty state.
 * A skeleton is the surface's own outline in still blocks, so the frame
 * around it does not jump when the real thing lands; nothing in it moves.
 */
export type SkeletonKind =
  /** A full page with a list column beside its content (Search, Inbox, Notes). */
  | "page"
  /** A page in the one 672px column under the title strip (Settings, Stats). */
  | "column"
  /** The Accounts page: the column with account rows (a dot, the name over its line, two usage bars, a switch). */
  | "accounts"
  /** A pane of text lines (the editor, release notes, an issue body). */
  | "pane"
  /** A diff: a header strip and two hunks (a diff, an edit row's body, a PR diff). */
  | "diff"
  /** A terminal: the dark host with a prompt block (the terminal, the dev servers pane). */
  | "terminal"
  /** A framed document (an HTML render, an image, a file). */
  | "frame"
  /** A thread while its transcript loads: prompts on the right, answers under them. */
  | "transcript"
  /** A list in a panel or dialog: `count` rows of a title over a line. */
  | "rows";

const PROSE = [72, 48, 88, 36, 64, 56];
const NAV = [60, 45, 70, 50, 65, 40, 55, 48];
const HUNK = [64, 40, 76, 52, 30];

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

function body(kind: SkeletonKind, count: number): ReactNode {
  switch (kind) {
    case "page":
      return (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-52 shrink-0 flex-col border-r border-border p-2">
            {NAV.map((width, i) => (
              <div key={i} className="flex h-9 items-center px-3">
                <Skeleton className="h-3" style={{ width: `${width}%` }} />
              </div>
            ))}
          </div>
          <div className="min-w-0 flex-1 px-8 pt-8">
            <div className="max-w-2xl">
              <Skeleton className="h-4 w-32" />
              <div className="mt-6 flex flex-col gap-4">
                {Array.from({ length: 5 }, (_, i) => (
                  <div key={i} className="flex items-center gap-4">
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <Skeleton className="h-3 w-40 max-w-full" />
                      <Skeleton className="h-2.5 w-64 max-w-full" />
                    </div>
                    <Skeleton className="h-5 w-9 rounded-full" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      );
    case "column":
    case "accounts":
      // components/page.tsx's frame: the strip, then Page's column in the
      // page's own scroller, with its title, its line and rows in the shape
      // of the page it stands in for.
      return (
        <>
          <div className="h-10 shrink-0 border-b border-border" />
          <div data-skeleton-scroller className={PAGE_SCROLLER}>
            <div data-skeleton-column className="mx-auto w-full max-w-2xl p-6">
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
                        <Skeleton data-skeleton-switch className="h-5 w-9 rounded-full" />
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
        <div className="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-8">
          {[3, 4, 5].map((lines, i) => (
            <div key={i} className="flex flex-col gap-4">
              <Skeleton className="h-9 w-2/5 self-end rounded-xl" />
              <Lines widths={PROSE} count={lines} className="h-3" gap="gap-3" />
            </div>
          ))}
        </div>
      );
    case "rows":
      return (
        <div className="flex flex-col gap-1">
          {Array.from({ length: count }, (_, i) => (
            <div key={i} data-skeleton-row className="flex h-12 flex-col justify-center gap-2 px-3">
              <Skeleton className="h-3 w-40 max-w-full" />
              <Skeleton className="h-2.5 w-56 max-w-full" />
            </div>
          ))}
        </div>
      );
  }
}

const FRAME: Record<SkeletonKind, string> = {
  page: "flex min-h-0 min-w-0 flex-1 flex-col",
  column: "flex min-h-0 min-w-0 flex-1 flex-col",
  accounts: "flex min-h-0 min-w-0 flex-1 flex-col",
  pane: "h-full min-h-0 w-full overflow-hidden",
  diff: "flex h-full min-h-0 w-full flex-col overflow-hidden",
  terminal: "monocode-terminal flex h-full min-h-0 w-full flex-col",
  frame: "flex h-full min-h-0 w-full p-3",
  transcript: "h-full min-h-0 w-full overflow-hidden px-4 pt-6",
  rows: "w-full",
};

export function SurfaceSkeleton({ kind, label, count = 4 }: { kind: SkeletonKind; label?: string; count?: number }) {
  return (
    <div role="status" aria-label={label ?? "Loading"} aria-busy data-surface-skeleton={kind} className={`select-none ${FRAME[kind]}`}>
      {body(kind, count)}
    </div>
  );
}

/** A small section waiting on an answer whose shape is unknown: a spinner
 *  beside its word, centred. */
export function LoadingLine({ label }: { label: string }) {
  return (
    <div role="status" aria-busy className="flex select-none items-center justify-center gap-2 py-6 text-[12px] text-muted-foreground">
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
