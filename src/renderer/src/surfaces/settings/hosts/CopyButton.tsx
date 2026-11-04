import { COPIED_MS, copyText } from "../../../lib/clipboard";
import { useEffect, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip";
import { Check, Copy } from "../../../chrome/icons";
import { SwapIcon } from "../../../motion/IconSwap";

/** A ghost icon button that copies `text`; the check stands in for a moment after. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => void copyText(text).then(() => setCopied(true), () => setCopied(false))}
          />
        }
      >
        <SwapIcon swapped={copied} from={<Copy />} to={<Check />} />
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : label}</TooltipContent>
    </Tooltip>
  );
}
