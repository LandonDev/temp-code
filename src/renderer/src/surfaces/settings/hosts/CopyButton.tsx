import { useEffect, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip";
import { Check, Copy } from "../../../chrome/icons";

/** A ghost icon button that copies `text`; the check stands in for a moment after. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1200);
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
            onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
          />
        }
      >
        {copied ? <Check strokeWidth={2.25} /> : <Copy strokeWidth={1.75} />}
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : label}</TooltipContent>
    </Tooltip>
  );
}
