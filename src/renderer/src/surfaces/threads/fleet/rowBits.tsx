import { Fragment, type ReactNode } from "react";
import { StatusMark, threadStateOf } from "../../../components/ui/status";
import type { SessionMeta } from "../../../lib/tcserver/types";
import type { NumberPart } from "./useFleetModel";

/**
 * The pieces a thread row is built from, shared by the fleet's agent rows
 * and detail and the master board's MasterRow: the status glyph and the
 * numbers line.
 */

/** The state's glyph alone, from the vocabulary; a settled idle is done. */
export function StatusGlyph({ status }: { status: SessionMeta["status"] }) {
  return <StatusMark state={threadStateOf(status, { settled: true })} word={false} />;
}

/** The detail's numbers as one muted line, two spaces between facts: the
 *  diff in green and red, then tasks, context, cost and elapsed. `lead` is
 *  plain words before them (the host, model, effort, branch). */
export function AgentNumbersLine({
  parts,
  lead = [],
  className = "",
}: {
  parts: NumberPart[];
  lead?: ReactNode[];
  className?: string;
}) {
  const before = lead.filter((t) => t !== null && t !== undefined && t !== false && t !== "");
  if (parts.length === 0 && before.length === 0) return null;
  return (
    <span
      data-slot="agent-numbers"
      className={`flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground tabular-nums ${className}`}
    >
      {before.map((t, i) =>
        typeof t === "string" || typeof t === "number" ? <span key={`lead-${i}`}>{t}</span> : <Fragment key={`lead-${i}`}>{t}</Fragment>,
      )}
      {parts.map((p) =>
        p.key === "diff" ? (
          <span key={p.key}>
            <span className="text-success">+{p.adds}</span> <span className="text-destructive">−{p.dels}</span>
          </span>
        ) : (
          <span key={p.key}>{p.text}</span>
        ),
      )}
    </span>
  );
}
