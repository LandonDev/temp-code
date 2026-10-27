import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { openUrl, useCallPortOpen } from "../lib/devPorts";

/**
 * A shell call that opened a dev server (docs/box.md "Dev servers on the
 * box"): its row ends with where it opens here. "Open on the Mac" for a box
 * thread's server forwarded to this Mac, "Open in browser" for one of this
 * Mac's own; the number after it is the one this Mac serves it on, so a
 * forward that moved past a taken port says which.
 */
export function CallPortLink({ callId }: { callId: string | undefined }) {
  const open = useCallPortOpen(callId);
  if (!open) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            data-call-port={open.port}
            onClick={(e) => {
              e.stopPropagation();
              openUrl(open.url);
            }}
            className="px-1 font-normal text-muted-foreground hover:text-foreground"
          />
        }
      >
        {open.label}
        <span className="tabular-nums text-muted-foreground">:{open.port}</span>
      </TooltipTrigger>
      <TooltipContent>
        {open.url}
        {open.movedFrom ? <span className="ml-2">{open.movedFrom} is taken here</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}
