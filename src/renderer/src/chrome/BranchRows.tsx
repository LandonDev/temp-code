import { useEffect, useRef } from "react";
import { cn } from "../lib/cn";
import type { GitBranchInfo } from "../lib/fs";
import { Check, GitBranch, Plus } from "./icons";

export type BranchRow =
  | { kind: "create"; name: string }
  | { kind: "branch"; branch: GitBranchInfo };

type Row = BranchRow;

/**
 * BranchPicker's list: the create row and the branches, the highlighted one
 * kept in view. It shows only inside the open popover, so it rides the menu
 * chunk (chrome/menuBody.tsx) instead of the first paint.
 */
export function BranchRows({
  rows,
  active,
  busy,
  emptyLabel,
  onActive,
  onPick,
}: {
  rows: Row[];
  active: number;
  busy: boolean;
  emptyLabel: string;
  onActive: (index: number) => void;
  onPick: (row: Row) => void;
}) {
  const activeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (rows.length === 0) {
    return <div className="px-2 py-1.5 text-xs text-muted-foreground">{emptyLabel}</div>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
      <div role="listbox" aria-label="Branches">
        {rows.map((row, index) => {
          const highlighted = index === active;
          const selected = row.kind === "branch" && row.branch.current;
          return (
            <div
              key={
                row.kind === "create"
                  ? `create:${row.name}`
                  : `${row.branch.remote ?? "local"}:${row.branch.name}`
              }
              ref={highlighted ? activeRef : undefined}
              role="option"
              aria-selected={selected}
              aria-disabled={busy}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => onActive(index)}
              onClick={() => {
                if (!busy) onPick(row);
              }}
              className={cn(
                "flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-[13px]",
                busy ? "opacity-50" : highlighted && "bg-muted",
              )}
            >
              {row.kind === "create" ? (
                <>
                  <Plus className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">Create and checkout {row.name}</span>
                </>
              ) : (
                <>
                  <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{row.branch.name}</span>
                  {row.branch.remote ? (
                    <span className="shrink-0 text-xs text-muted-foreground">{row.branch.remote}</span>
                  ) : null}
                  {selected ? <Check className="size-3.5 shrink-0" /> : null}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
