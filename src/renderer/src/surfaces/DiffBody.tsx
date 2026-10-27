import { DiffLine } from "../chrome/FilePreview";
import { DIFF_LINE_CAP, type DiffRow } from "./diffRows";

/**
 * The diff body of an edit row: the rows, a gap between hunks, a line when
 * the diff is cut, and a click on a numbered row that opens the inline
 * editor at that line.
 */
export function DiffBody({
  rows,
  onEditAt,
}: {
  rows: DiffRow[];
  onEditAt?: (line: number) => void;
}) {
  const shown = rows.slice(0, DIFF_LINE_CAP);
  return (
    <div className="py-1">
      {shown.map((row, n) =>
        row.type === "gap" ? (
          <div key={n} className="h-[18px] select-none pl-7 font-mono text-[11px] leading-[18px] text-muted-foreground">
            ⋯
          </div>
        ) : (
          <DiffLine
            key={n}
            number={row.type === "del" ? row.oldNo : row.newNo}
            kind={row.type}
            text={row.text}
            onClick={editAt(row, onEditAt)}
          />
        ),
      )}
      {rows.length > DIFF_LINE_CAP ? (
        <div className="select-none pt-1 pl-7 text-[11px] tabular-nums text-muted-foreground">
          Showing the first {DIFF_LINE_CAP} lines
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
