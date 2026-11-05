import { COPIED_MS } from "../lib/clipboard";
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "../chrome/icons";
import { Tip } from "../components/tip";
import { Button } from "../components/ui/button";
import { reveal } from "../components/ui/reveal";
import { copyUserMessage } from "../lib/copyMessage";
import { SwapIcon } from "../motion/IconSwap";
import type { Attachment } from "../lib/session";
import { playCue } from "../lib/sounds";

/**
 * Copy a prompt as sent — its text for anywhere, and its attachments and
 * thread mentions for a paste back into the composer. Shows on hover, left
 * of the bubble.
 */
export function CopyMessageButton({
  text,
  attachments,
}: {
  text: string;
  attachments: Attachment[];
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );
  return (
    // The reveal rides a wrapper, so the button keeps its own hover fill's transition.
    <span className={`absolute -left-8 top-1/2 z-10 flex -translate-y-1/2 ${reveal("message")}`}>
    <Tip label={copied ? "Copied" : "Copy message"}>
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? "Copied" : "Copy message"}
      className="text-muted-foreground"
      onClick={(event) => {
        event.stopPropagation();
        playCue("copy");
        void copyUserMessage({ text, attachments }).then(
          () => {
            setCopied(true);
            if (timer.current != null) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
          },
          () => {},
        );
      }}
    >
      <SwapIcon swapped={copied} from={<Copy className="size-3.5" />} to={<Check className="size-3.5" />} />
    </Button>
    </Tip>
    </span>
  );
}
