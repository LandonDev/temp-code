import { Plus, Undo2 } from "../chrome/icons";
import { Tip } from "../components/tip";
import { Button } from "../components/ui/button";
import { TooltipProvider } from "../components/ui/tooltip";

export function HunkBar({ onRevert, onStage, busy = false }: {
  onRevert(): void;
  onStage?: () => void;
  busy?: boolean;
}) {
  return (
    <TooltipProvider>
      <div className="flex flex-col" role="toolbar" aria-label="Change actions" onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}>
        <Tip label="Revert change">
          <Button variant="ghost" size="icon-xs" aria-label="Revert change" disabled={busy} onClick={onRevert}>
            <Undo2 />
          </Button>
        </Tip>
        {onStage ? (
          <Tip label="Stage change">
            <Button variant="ghost" size="icon-xs" aria-label="Stage change" disabled={busy} onClick={onStage}>
              <Plus />
            </Button>
          </Tip>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
