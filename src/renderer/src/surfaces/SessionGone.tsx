import { Button } from "@renderer/components/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@renderer/components/ui/empty";
import { hostName } from "../lib/threadResources";
import { shell } from "../stores/shell";

/**
 * A pane whose thread no host has: the host stopped listing it (deleted,
 * swept) or a provisional open found it nowhere. One line naming the host,
 * then the two ways on: close the pane (its tab, when alone), or look for
 * it among the archived.
 */
export function SessionGone({
  id,
  host,
  inSplit = false,
  onClose,
}: {
  id: string;
  /** The environment the thread was last on, when known. */
  host?: string;
  /** In a split, Close takes this pane only. */
  inSplit?: boolean;
  onClose: (sessionId: string) => void;
}) {
  return (
    <Empty data-session-gone={id}>
      <EmptyHeader>
        <EmptyTitle>{host ? `No longer on ${hostName(host)}` : "No longer on any host"}</EmptyTitle>
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center">
        <Button variant="secondary" size="sm" onClick={() => onClose(id)}>
          {inSplit ? "Close pane" : "Close tab"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => shell.openSettings("archive")}>
          Open archived
        </Button>
      </EmptyContent>
    </Empty>
  );
}
