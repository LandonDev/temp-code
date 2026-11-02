import { DiffLine } from "../chrome/FilePreview";
import { DIFF_LINE_CAP, type DiffRow } from "./diffRows";

/**
 * The diff body of an edit row: the rows, a gap between hunks, a line when
 * the diff is cut, and a click on a numbered row that opens the inline
 * editor at that line. Every line is 20px; `inset` pads each one 12px a
 * side, so in a card with no side padding the tints run to its edges and
 * the numbers start 12px in.
 */
export function DiffBody({
  rows,
  onEditAt,
  inset = false,
}: {
  rows: DiffRow[];
  onEditAt?: (line: number) => void;
  inset?: boolean;
}) {
  const shown = rows.slice(0, DIFF_LINE_CAP);
  const side = inset ? " px-3" : "";
  return (
    <div className="py-1">
      {shown.map((row, n) =>
        row.type === "gap" ? (
          <div key={n} data-diff-gap className={`h-5 select-none font-mono text-xs leading-5 text-muted-foreground${side}`}>
            <span className="ps-7">⋯</span>
          </div>
        ) : (
          <DiffLine
            key={n}
            number={row.type === "del" ? row.oldNo : row.newNo}
            kind={row.type}
            text={row.text}
            inset={inset}
            onClick={editAt(row, onEditAt)}
          />
        ),
      )}
      {rows.length > DIFF_LINE_CAP ? (
        <div className={`select-none pt-1 text-[11px] tabular-nums text-muted-foreground${side}`}>
          <span className="ps-7">Showing the first {DIFF_LINE_CAP} lines</span>
        </div>
      ) : null}
    </div>
  );
}

/** A numbered row opens the inline editor at its line; a removed one has
 *  no line to open. */
function editAt(row: DiffRow, onEditAt?: (line: number) => void) {
  const line = row.newNo;
  if (!onEditAt || row.type === "del" || line === undefined) return undefined;
  return () => onEditAt(line);
}
