import { highlightCode } from "../chrome/FilePreview";
import { DIFF_LINE_CAP, type DiffRow } from "./diffRows";

/**
 * The diff body of an edit row. Same line markup as the file preview —
 * bar, number, mark, mono text — plus gaps between hunks, a reveal slice
 * for the timed pour-in, and a click on a numbered row that opens the
 * inline editor at that line.
 */
export function DiffBody({
  rows,
  visible,
  onEditAt,
}: {
  rows: DiffRow[];
  /** how many rows to show so far; undefined shows all */
  visible?: number;
  onEditAt?: (line: number) => void;
}) {
  const limit = Math.min(DIFF_LINE_CAP, visible ?? DIFF_LINE_CAP);
  const shown = rows.slice(0, limit);
  return (
    <div className="py-1">
      {shown.map((row, n) =>
        row.type === "gap" ? (
          <div
            key={n}
            className="select-none pl-7 font-mono text-[10px] leading-4 text-content/40"
          >
            ⋯
          </div>
        ) : (
          <DiffLine key={n} row={row} onEditAt={onEditAt} />
        ),
      )}
      {rows.length > DIFF_LINE_CAP && visible === undefined ? (
        <div className="pl-7 font-mono text-[10px] leading-4 text-content/40">
          … diff truncated
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
  const bg = add ? "bg-success/10" : del ? "bg-danger/10" : "";
  const bar = add ? "bg-success" : del ? "bg-danger" : "bg-transparent";
  const mark = add ? "+" : del ? "−" : " ";
  const markColor = add ? "text-success" : del ? "text-danger" : "text-content/30";
  const number = del ? row.oldNo : row.newNo;
  const editable = onEditAt !== undefined && !del && row.newNo !== undefined;
  const line = row.newNo;
  return (
    <div
      className={`relative flex items-baseline ${bg} ${
        editable ? "cursor-pointer hover:bg-content/6" : ""
      }`}
      title={editable ? "Edit here" : undefined}
      onClick={editable && line !== undefined ? () => onEditAt(line) : undefined}
    >
      <span className={`absolute inset-y-0 left-0 w-0.5 ${bar}`} />
      <span className="w-7 shrink-0 pr-1 text-right font-mono text-[10px] text-content/40">
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
