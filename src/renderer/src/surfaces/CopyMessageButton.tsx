import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "../chrome/icons";
import { copyUserMessage } from "../lib/copyMessage";
import type { Attachment } from "../lib/session";
import { playCue } from "../lib/sounds";

/**
 * Copy a prompt as sent — its text for anywhere, and its attachments and
 * thread mentions for a paste back into the composer. Shows on hover in the
 * bubble's corner.
 */
export function CopyMessageButton({
  text,
  attachments,
  chat,
}: {
  text: string;
  attachments: Attachment[];
  chat: boolean;
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
    <button
      type="button"
      title={copied ? "Copied" : "Copy message"}
      aria-label={copied ? "Copied" : "Copy message"}
      className={`absolute z-10 rounded-md bg-background-base/80 p-1 text-content/50 opacity-0 glass-surface transition-opacity hover:bg-content/10 hover:text-content/80 focus-visible:opacity-100 group-hover/message:opacity-100 ${
        chat ? "-left-8 top-1/2 -translate-y-1/2" : "right-1.5 top-1.5"
      }`}
      onClick={(event) => {
        event.stopPropagation();
        playCue("copy");
        void copyUserMessage({ text, attachments }).then(
          () => {
            setCopied(true);
            if (timer.current != null) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), 2000);
          },
          () => {},
        );
      }}
    >
      {copied ? <Check className="size-3.5" strokeWidth={1.75} /> : <Copy className="size-3.5" strokeWidth={1.75} />}
    </button>
  );
}
