import { useCallback, useLayoutEffect, useState, type ReactNode } from "react";
import { registerToastAnchor } from "../../lib/toastAnchor";
import { COLUMN_MAX_CLASS, GUTTER_FROM_PX, LIST_SPACE, type OutlinePlacement } from "../transcriptOutlineModel";

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
      <ChatFooter slots={slots} follow />
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
 * The transcript's placement read off the transcript beside the footer: its
 * message list mounted, then the transcript's own width rule
 * (`outlinePlacement`, against the scroller's client width).
 */
export function placementOfScroller(scroller: HTMLElement | null): OutlinePlacement {
  if (!scroller?.querySelector(":scope > [data-transcript-outline]")) return "hidden";
  return scroller.clientWidth < GUTTER_FROM_PX ? "beside" : "gutter";
}

/** Follows the transcript that sits just before the footer (the column's own), so the footer's column lands where the transcript's does. */
function useFollowedPlacement(follow: boolean): [(el: HTMLDivElement | null) => void, OutlinePlacement] {
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<OutlinePlacement>("hidden");
  useLayoutEffect(() => {
    const host = follow ? footer?.previousElementSibling : null;
    if (!host) return;
    let watched: Element | null = null;
    const sizes = new ResizeObserver(() => read());
    const read = () => {
      const scroller = host.querySelector<HTMLElement>(".agent-transcript");
      if (scroller !== watched) {
        if (watched) sizes.unobserve(watched);
        if (scroller) sizes.observe(scroller);
        watched = scroller;
      }
      setPlacement(placementOfScroller(scroller));
    };
    // The transcript mounts in a deferred pass and its list comes and goes.
    const mounts = new MutationObserver(read);
    mounts.observe(host, { childList: true, subtree: true });
    read();
    return () => {
      mounts.disconnect();
      sizes.disconnect();
    };
  }, [follow, footer]);
  return [useCallback((el: HTMLDivElement | null) => setFooter(el), []), follow ? placement : "hidden"];
}

/**
 * The footer alone, for a view that seats the transcript elsewhere: the
 * column's gutter outside, the column inside, so the composer's box edges are
 * the column's edges. `follow` reads the placement off the transcript just
 * before it (`ChatColumn`); `placement` names it outright.
 */
export function ChatFooter({
  slots,
  className = "",
  follow = false,
  placement,
}: {
  slots: ChatSlots;
  className?: string;
  follow?: boolean;
  placement?: OutlinePlacement;
}) {
  const [footerRef, followed] = useFollowedPlacement(follow && !placement);
  const where = placement ?? followed;
  const anchored = !!slots.anchor;
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      footerRef(el);
      const release = anchored ? registerToastAnchor(el) : undefined;
      return () => {
        release?.();
        footerRef(null);
      };
    },
    [anchored, footerRef],
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
