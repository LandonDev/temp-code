import type { ReactNode } from "react";

/**
 * The chat column pulled into its three slots so a view can seat them
 * apart: the transcript in a side panel, the composer under a board. A
 * view that wants the plain column asks `chatOf` and gets the same
 * stack the pane builds on its own.
 */

/** What a view may ask of the chat column it is handed. */
export type ChatOpts = {
  /** Rides the composer's top edge (the pass banner). */
  topSlot?: ReactNode;
};

export type ChatSlots = {
  /** The transcript with its jump-to-bottom button; fills its container. */
  transcript: ReactNode;
  /** The working strip; null where the view has no use for it. */
  strip: ReactNode;
  composer: ReactNode;
};

export type RenderChat = (opts?: ChatOpts) => ReactNode;
export type RenderSlots = (opts?: ChatOpts) => ChatSlots;

export type ChatSource = {
  /** Builds the whole column; call it once per render. */
  renderChat: RenderChat;
  /** The same column as parts; present once the pane splits its chat. */
  renderSlots?: RenderSlots;
};

/** The stack the pane builds: transcript above, strip and composer in a centred footer. */
export function ChatColumn({ slots }: { slots: ChatSlots }) {
  return (
    <>
      {slots.transcript}
      <ChatFooter slots={slots} />
    </>
  );
}

/** The centred footer alone, for a view that seats the transcript elsewhere. */
export function ChatFooter({ slots, className = "" }: { slots: ChatSlots; className?: string }) {
  return (
    <div className={`mx-auto w-full max-w-4xl shrink-0 ${className}`}>
      {slots.strip}
      {slots.composer}
    </div>
  );
}

/** The plain column from whichever builder the pane handed over. */
export function chatOf(source: ChatSource, opts?: ChatOpts): ReactNode {
  return source.renderSlots ? <ChatColumn slots={source.renderSlots(opts)} /> : source.renderChat(opts);
}

/**
 * The column as parts when the pane split it, else the whole column in
 * `transcript` with the other slots empty: a view lays out its pieces
 * the same way either way and the composer renders exactly once.
 */
export function slotsOf(source: ChatSource, opts?: ChatOpts): ChatSlots {
  if (source.renderSlots) return source.renderSlots(opts);
  return { transcript: source.renderChat(opts), strip: null, composer: null };
}
