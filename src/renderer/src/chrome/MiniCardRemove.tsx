import { AttachmentAction, AttachmentActions } from "../components/ui/attachment";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { X } from "./icons";

/** The Remove action at the end of a composer mini card. */
export function MiniCardRemove({ label, onDismiss }: { label: string; onDismiss: () => void }) {
  return (
    <AttachmentActions>
      <Tooltip>
        <TooltipTrigger render={<AttachmentAction aria-label={label} onClick={onDismiss} />}>
          <X />
        </TooltipTrigger>
        <TooltipContent>Remove</TooltipContent>
      </Tooltip>
    </AttachmentActions>
  );
}
