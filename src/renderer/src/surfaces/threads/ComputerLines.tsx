import type { ComputerSessionRow } from "@server/shared/contract-computer";
import { StatusMark } from "@renderer/components/ui/status";

/**
 * What a computer session's Activity row opens onto where this desktop
 * cannot draw the session (the browser, a Linux desktop, a box thread
 * driving another Mac): a card waiting on its Mac, else a held step, each
 * one status line. Where the session can be drawn it is the Computer
 * section's, and Activity lists no row for it (lib/activity.ts).
 */
export function ComputerLines({ row }: { row: ComputerSessionRow }) {
  const line = row.asking ? (
    <StatusMark state="waiting" detail={row.asking.line} data-slot="computer-asking" />
  ) : row.running?.held ? (
    <StatusMark state="queued" detail={row.running.words} data-slot="computer-held" />
  ) : null;
  return line ? (
    <div className="px-2 pt-0.5 pb-2" data-slot="computer-lines">
      {line}
    </div>
  ) : null;
}
