import type { ComponentProps } from "react";
import { cn } from "@renderer/lib/cn";

/** The frame of one message in a transcript: content on one side, no
 *  avatar by default. `align="end"` is the person's side. The user bubble
 *  itself is the transcript's (surfaces/transcript). */
function MessageGroup({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="message-group" className={cn("flex min-w-0 flex-col gap-2", className)} {...props} />;
}

function Message({ className, align = "start", ...props }: ComponentProps<"div"> & { align?: "start" | "end" }) {
  return <div data-slot="message" data-align={align} className={cn("group/message relative flex w-full min-w-0 gap-2 text-sm data-[align=end]:flex-row-reverse", className)} {...props} />;
}

function MessageContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="message-content" className={cn("flex w-full min-w-0 flex-col gap-2.5 wrap-break-word group-data-[align=end]/message:*:data-slot:self-end", className)} {...props} />;
}

function MessageHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="message-header" className={cn("flex min-w-0 max-w-full items-center text-xs font-medium text-muted-foreground", className)} {...props} />;
}

function MessageFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="message-footer" className={cn("flex min-w-0 max-w-full items-center text-xs text-muted-foreground group-data-[align=end]/message:justify-end", className)} {...props} />;
}

export { MessageGroup, Message, MessageContent, MessageFooter, MessageHeader };
