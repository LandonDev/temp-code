import type { ReactNode } from "react";
import { cn } from "../../../lib/cn";

/**
 * Facts of one kind on one line, as one comma sentence ("App, operate,
 * never used"): separate spans that wrap between facts, each 4px from the
 * next (docs/DESIGN.md "Typography and text hierarchy": about a space), the
 * comma drawn after every fact but the last, so space never separates two
 * facts alone; tabular figures. Never joined by a middle dot. A fact may be
 * a node of its own tone (a warning).
 */
export function Facts({ parts, className }: { parts: readonly ReactNode[]; className?: string }) {
  const shown = parts.filter((part) => part !== null && part !== false && part !== undefined && part !== "");
  if (shown.length === 0) return null;
  return (
    <span
      data-slot="facts"
      className={cn("inline-flex min-w-0 flex-wrap gap-x-1 tabular-nums [&>span:not(:last-child)]:after:content-[',']", className)}
    >
      {shown.map((part, i) => (
        <span key={typeof part === "string" ? `${i}:${part}` : i}>{part}</span>
      ))}
    </span>
  );
}

/** Splits a line another module words with " · " (`devicesSummary`) into its facts. */
export function splitFacts(line: string): string[] {
  return line
    .split(" · ")
    .map((part) => part.trim())
    .filter(Boolean);
}
