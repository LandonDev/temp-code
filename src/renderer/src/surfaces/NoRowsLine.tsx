import { COLUMN_GUTTER_CLASS, columnClass } from "./threads/chatSlots";

/** A thread its host holds with no rows: the host's failure summary when
 *  it has one, else that no message has landed. On the load line's grid. */
export function NoRowsLine({ summary }: { summary?: string | null }) {
  return (
    <div className={`${COLUMN_GUTTER_CLASS} mt-2 shrink-0`}>
      <p role="status" data-no-rows className={`${columnClass()} py-0.5 text-xs leading-5 text-muted-foreground`}>
        {summary || "No messages yet"}
      </p>
    </div>
  );
}
