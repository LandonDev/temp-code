import { cn } from "../../../lib/cn";

/**
 * Facts on one line, as separate spans 8px apart that wrap, in tabular
 * figures. Never joined by a middle dot (docs/DESIGN.md "Settings").
 */
export function Facts({ parts, className }: { parts: readonly string[]; className?: string }) {
  if (parts.length === 0) return null;
  return (
    <span data-slot="facts" className={cn("inline-flex min-w-0 flex-wrap gap-x-2 tabular-nums", className)}>
      {parts.map((part, i) => (
        <span key={`${i}:${part}`}>{part}</span>
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
