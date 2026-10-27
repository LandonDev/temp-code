import { highlightCode } from "../chrome/FilePreview";
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
          <DiffLine key={n} row={row} onEditAt={onEditAt} />
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

function DiffLine({
  row,
  onEditAt,
}: {
  row: DiffRow;
  onEditAt?: (line: number) => void;
}) {
  const add = row.type === "add";
  const del = row.type === "del";
  const bg = add ? "bg-success/10" : del ? "bg-destructive/10" : "";
  const mark = add ? "+" : del ? "−" : " ";
  const markColor = add ? "text-success" : del ? "text-destructive" : "text-muted-foreground";
  const number = del ? row.oldNo : row.newNo;
  const line = row.newNo;
  const editable = onEditAt !== undefined && !del && line !== undefined;
  return (
    <div
      className={`flex items-baseline ${bg}`}
      onClick={editable ? () => onEditAt(line) : undefined}
    >
      <span className="w-7 shrink-0 select-none pr-1 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
        {number ?? ""}
      </span>
      <span className={`w-3 shrink-0 text-center font-mono text-[10px] font-bold ${markColor}`}>
        {mark}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap pr-2 font-mono text-[11px] leading-4.5 [overflow-wrap:anywhere]">
        {highlightCode(row.text, row.type === "ctx")}
      </span>
    </div>
  );
}
