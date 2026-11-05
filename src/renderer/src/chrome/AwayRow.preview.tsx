import { TooltipProvider } from "../components/ui/tooltip";
import { AwayRowView } from "./AwayRow";
import { Settings } from "./icons";
import { RailRow } from "./RailRow";

/** The rail foot's last two rows at a width the rail takes, for
 *  `bun run ui:preview src/renderer/src/chrome/AwayRow.preview.tsx#AwayFootPreview`. */
export function AwayFootPreview({ enabled, at = 0 }: { enabled: boolean; at?: number }) {
  return (
    <TooltipProvider>
      <div className="flex w-[248px] flex-col border-t border-border bg-sidebar p-2">
        <AwayRowView enabled={enabled} at={at} onToggle={() => {}} />
        <RailRow icon={Settings} label="Settings" />
      </div>
    </TooltipProvider>
  );
}
