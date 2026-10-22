/**
 * The fallback a lazy surface (lib/lazyChunk.tsx) shows while its chunk
 * loads: the surface's own outline in faint bars, so the frame around it
 * does not jump when the real thing lands. On a warm machine the chunk is
 * usually preloaded and none of this is ever seen.
 */
export type SkeletonKind =
  /** A full page with a header bar and a sidebar column (Settings, the Aliax pages). */
  | "page"
  /** A pane of text lines (the editor, release notes, the research board). */
  | "pane"
  /** A diff: a header strip and hunks of short bars (the changes pane, an edit card). */
  | "diff"
  /** A terminal: the dark host with a prompt bar. */
  | "terminal"
  /** A framed document (an HTML render, an image). */
  | "frame"
  /** A thread's rows while its transcript loads: prompts on the right, answers under them. */
  | "transcript";

const bar = "rounded bg-content/8";

function Lines({ count, className = "" }: { count: number; className?: string }) {
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={`h-2.5 ${bar}`} style={{ width: `${[72, 48, 88, 36, 64, 56][i % 6]}%` }} />
      ))}
    </div>
  );
}

export function SurfaceSkeleton({ kind, label }: { kind: SkeletonKind; label?: string }) {
  const base = "animate-pulse select-none text-content";
  const aria = { role: "status" as const, "aria-label": label ?? "Loading", "data-surface-skeleton": kind };
  switch (kind) {
    case "page":
      return (
        <div {...aria} className={`flex min-h-0 min-w-0 flex-1 flex-col ${base}`}>
          <div className="flex h-10 shrink-0 items-center gap-3 border-b border-content/10 px-4">
            <div className={`h-3 w-24 ${bar}`} />
          </div>
          <div className="flex min-h-0 flex-1">
            <div className="w-52 shrink-0 border-r border-content/10 p-4">
              <Lines count={7} />
            </div>
            <div className="flex-1 p-6">
              <div className={`mb-4 h-4 w-40 ${bar}`} />
              <Lines count={6} className="max-w-xl" />
            </div>
          </div>
        </div>
      );
    case "pane":
      return (
        <div {...aria} className={`h-full min-h-0 w-full overflow-hidden p-4 ${base}`}>
          <Lines count={10} className="max-w-2xl" />
        </div>
      );
    case "diff":
      return (
        <div {...aria} className={`h-full min-h-0 w-full overflow-hidden ${base}`}>
          <div className="flex h-8 items-center gap-2 border-b border-content/10 px-3">
            <div className={`h-2.5 w-28 ${bar}`} />
          </div>
          <div className="p-3">
            <Lines count={4} className="max-w-lg" />
            <div className="mt-4">
              <Lines count={3} className="max-w-lg" />
            </div>
          </div>
        </div>
      );
    case "terminal":
      return (
        <div {...aria} className={`monocode-terminal flex h-full min-h-0 w-full flex-col ${base}`}>
          <div className="min-h-0 flex-1 p-2">
            <div className={`h-3 w-16 ${bar}`} />
          </div>
        </div>
      );
    case "transcript":
      return (
        <div {...aria} className={`mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col gap-8 overflow-hidden px-4 pt-6 ${base}`}>
          {[4, 3, 5].map((count, i) => (
            <div key={i} className="flex flex-col gap-4">
              <div className={`h-7 w-2/5 self-end ${bar}`} />
              <Lines count={count} className="max-w-2xl" />
            </div>
          ))}
        </div>
      );
    case "frame":
      return (
        <div {...aria} className={`flex h-full min-h-0 w-full items-center justify-center p-3 ${base}`}>
          <div className={`h-full min-h-24 w-full ${bar}`} />
        </div>
      );
  }
}
