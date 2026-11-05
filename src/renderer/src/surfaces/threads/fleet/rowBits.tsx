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

/** The detail's numbers as one muted line: `lead`'s elements first (the
 *  model line, the host glyph), 8px apart, then every word and number as
 *  one comma run, "main, +12 −3, 3 tasks, $0.12": `lead`'s plain words (the
 *  branch), the diff in green and red, tasks, context and cost. Never two
 *  facts set apart by space alone. */
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
  const words: ReactNode[] = [
    ...before.filter(isWords),
    ...parts.map((p) =>
      p.key === "diff" ? (
        <span key={p.key}>
          <span className="text-success">+{p.adds}</span> <span className="text-destructive">−{p.dels}</span>
        </span>
      ) : (
        p.text
      ),
    ),
  ];
  return (
    <span
      data-slot="agent-numbers"
      className={`flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground tabular-nums ${className}`}
    >
      {before.filter((t) => !isWords(t)).map((t, i) => (
        <Fragment key={`lead-${i}`}>{t}</Fragment>
      ))}
      {words.length > 0 ? (
        <span data-slot="agent-facts" className="min-w-0">
          {words.map((w, i) => (
            <Fragment key={i}>
              {i > 0 ? ", " : null}
              {w}
            </Fragment>
          ))}
        </span>
      ) : null}
    </span>
  );
}

const isWords = (t: ReactNode): t is string | number => typeof t === "string" || typeof t === "number";
