import { useCallback, type ReactNode } from "react";
import { registerToastAnchor } from "../../lib/toastAnchor";
import { tallyRender } from "../../lib/devRenders";
import { COLUMN_MAX_CLASS, LIST_SPACE, type OutlinePlacement } from "../transcriptOutlineModel";

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
  /** The pane holds the focus: the toast stack sits above this footer. */
  anchor?: boolean;
  /** Where the transcript's column sits (its message list's placement, which
   *  AgentTranscript reports), so the footer's column lands on it. */
  placement?: OutlinePlacement;
};

export type RenderChat = (opts?: ChatOpts) => ReactNode;
export type RenderSlots = (opts?: ChatOpts) => ChatSlots;

export type ChatSource = {
  /** Builds the whole column; call it once per render. */
  renderChat: RenderChat;
  /** The same column as parts; present once the pane splits its chat. */
  renderSlots?: RenderSlots;
};

/** The stack the pane builds: transcript above, strip and composer in a footer
 *  whose edges are the transcript column's. */
export function ChatColumn({ slots }: { slots: ChatSlots }) {
  return (
    <>
      {slots.transcript}
      <ChatFooter slots={slots} />
    </>
  );
}

/**
 * The gutter around the column, the transcript scroller's to the pixel: 16px
 * a side, plus on the end the scrollbar's strip the scroller reserves
 * (`scrollbar-gutter: stable`), which the footer and the empty screen have
 * no scrollbar to reserve. The empty box and the docked one share it, so a
 * first send moves the box and never resizes it.
 */
export const COLUMN_GUTTER_CLASS = "w-full ps-4 pe-[calc(1rem+var(--scrollbar-size))]";

/** The column inside that gutter: centred, or after the message list when it sits beside. */
export function columnClass(placement: OutlinePlacement = "hidden"): string {
  return `${placement === "beside" ? "mr-auto" : "mx-auto"} w-full ${COLUMN_MAX_CLASS}`;
}

/**
 * The footer alone, for a view that seats the transcript elsewhere: the
 * column's gutter outside, the column inside, so the composer's box edges are
 * the column's edges, in the placement the slots carry (`placement` names it
 * outright).
 */
export function ChatFooter({
  slots,
  className = "",
  placement,
}: {
  slots: ChatSlots;
  className?: string;
  placement?: OutlinePlacement;
}) {
  tallyRender("chatFooter");
  const where = placement ?? slots.placement ?? "hidden";
  const anchored = !!slots.anchor;
  const ref = useCallback(
    (el: HTMLDivElement | null) => (anchored ? registerToastAnchor(el) : undefined),
    [anchored],
  );
  return (
    <div
      ref={ref}
      data-toast-anchor={slots.anchor ? "" : undefined}
      data-chat-footer={where}
      className={`${COLUMN_GUTTER_CLASS} shrink-0 ${className}`}
      style={where === "beside" ? { paddingLeft: LIST_SPACE } : undefined}
    >
      <div className={columnClass(where)}>
        {slots.strip}
        {slots.composer}
      </div>
    </div>
  );
}

/** The plain column from whichever builder the pane handed over. */
export function chatOf(source: ChatSource, opts?: ChatOpts): ReactNode {
  return source.renderSlots ? <ChatColumn slots={source.renderSlots(opts)} /> : source.renderChat(opts);
}

/** The thread's own paused row for a board whose chat is folded
 *  (SplitShell's `held`): the strip itself, with its Stop and Continue,
 *  while the thread or its tree is paused; null otherwise and where the
 *  pane did not split its chat. */
export function heldRowOf(source: ChatSource, session: { status?: string | null; parentId?: string | null; treeHasPaused?: boolean }): ReactNode {
  const paused = session.status === "paused" || (!session.parentId && !!session.treeHasPaused);
  return paused && source.renderSlots ? source.renderSlots().strip : null;
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
