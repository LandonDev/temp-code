import type { PointerEvent as ReactPointerEvent } from "react";
import { X } from "../chrome/icons";
import { Button } from "../components/ui/button";
import { Kbd } from "../components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import { MOD } from "../lib/platform";

/**
 * A split pane's header: the thread's title and Close. The focused pane's
 * header is the content's own background with the title in foreground; the
 * others sit on the rail's gray with a muted title. The whole header drags
 * the pane; a press inside `[data-no-drag]` does not.
 */
export function PaneHeader({
  title,
  focused,
  onClose,
  onDragStart,
}: {
  title: string;
  focused: boolean;
  onClose: () => void;
  onDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  return (
    <div
      data-pane-header
      data-focused={focused}
      className={cn(
        "flex h-9 shrink-0 touch-none items-center gap-2 border-b border-border px-3 select-none",
        focused ? "bg-background" : "bg-sidebar",
        onDragStart && "cursor-grab active:cursor-grabbing",
      )}
      onPointerDown={(event) => {
        if (event.button !== 0 || !onDragStart) return;
        if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) return;
        onDragStart(event);
      }}
    >
      <span className={cn("min-w-0 flex-1 truncate text-[13px]", focused ? "text-foreground" : "text-muted-foreground")}>
        {title}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close pane"
              data-no-drag
              className="-mr-1.5"
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onClose();
              }}
            />
          }
        >
          <X className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent>
          Close pane
          <Kbd size="sm">{`${MOD}W`}</Kbd>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
