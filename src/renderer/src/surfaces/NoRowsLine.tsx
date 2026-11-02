import { COLUMN_MAX_CLASS } from "./transcriptOutlineModel";

/** A thread its host holds with no rows: the host's failure summary when
 *  it has one, else that no message has landed. On the load line's grid. */
export function NoRowsLine({ summary }: { summary?: string | null }) {
  return (
    <p
      role="status"
      data-no-rows
      className={`mx-auto mt-2 w-full ${COLUMN_MAX_CLASS} shrink-0 px-4 py-0.5 text-[12px] leading-5 text-muted-foreground`}
    >
      {summary || "No messages yet"}
    </p>
  );
}
