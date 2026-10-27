import { cn } from "@renderer/lib/cn";
import { basename } from "../../lib/fs";

/* The pieces of a changed-file row the Changes section's two groups share
   (ChangesPanel's index rows, ChangesAgainst's rows against a target). */

/** `+n −n` in the diff colours; New for a file git has not seen, Deleted for one that is gone. */
export function Counts({ status, additions, deletions }: { status: string; additions: number; deletions: number }) {
  if (status === "untracked" || status === "added") return <span className="text-xs text-muted-foreground">New</span>;
  if (status === "deleted") return <span className="text-xs text-muted-foreground">Deleted</span>;
  return (
    <span className="text-xs tabular-nums">
      {additions > 0 ? <span className="text-success">+{additions}</span> : null}
      {additions > 0 && deletions > 0 ? " " : null}
      {deletions > 0 ? <span className="text-destructive">−{deletions}</span> : null}
    </span>
  );
}

/** A file's name with its folder after it, the folder truncating first. */
export function FileName({ relative, muted }: { relative: string; muted?: boolean }) {
  const name = basename(relative);
  const dir = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className={cn("shrink-0 truncate text-[13px]", muted ? "text-muted-foreground" : "text-foreground")}>{name}</span>
      {dir ? <span className="min-w-0 truncate text-xs text-muted-foreground">{dir}</span> : null}
    </span>
  );
}
