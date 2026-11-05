import { useEffect, useState } from "react";
import { DUR } from "../../lib/ease";
import type { PanelMotion } from "../RightPanel";
import type { OpenFileFn } from "../../lib/search";
import type { Session } from "../../lib/session";
import type { ChatSource } from "./chatSlots";
import { ChatView } from "./ChatView";
import { threadViewsChunk } from "../chunks";
import { SurfaceSkeleton } from "../SurfaceSkeleton";
import { isMasterThread } from "../../lib/masterThread";

// Every view but the chat rides the thread-views chunk (surfaces/chunks.ts),
// preloaded in the idle slot after the first thread opens (SessionPane).
const skeleton = <SurfaceSkeleton kind="pane" label="Loading thread" />;
const ImplementationView = threadViewsChunk.surface("ImplementationView", skeleton);
const MasterView = threadViewsChunk.surface("MasterView", skeleton);
const OrchestrationView = threadViewsChunk.surface("OrchestrationView", skeleton);
const PlanView = threadViewsChunk.surface("PlanView", skeleton);
const ResearchView = threadViewsChunk.surface("ResearchView", skeleton);
// The panel rides its own chunk and mounts only while open, so a closed panel costs nothing.
const RightPanel = rightPanelChunk.surface("RightPanel", <SurfaceSkeleton kind="pane" label="Loading panel" />);
import { panelFit, rightPanel, THREAD_MIN, useRightPanel } from "../../lib/rightPanel";
import { rightPanelChunk } from "../chunks";

export type { ChatOpts } from "./chatSlots";

export type ThreadViewProps = ChatSource & {
  session: Session;
  /** The board is hidden while a new pass is being composed. */
  composing: boolean;
  onArmNewPass: (armed: boolean) => void;
  onOpenFile: OpenFileFn;
  onOpenDiff: (path?: string) => void;
  onShowSourceControl?: () => void;
  onOpenSession?: (sessionId: string) => void;
};

/** The switch on a session's thread type; null and chat fall through to
 *  ChatView, and a master thread (CLAUDE.md "Master threads") to
 *  MasterView whatever its type. Every root thread carries the right
 *  panel at its edge (surfaces/RightPanel.tsx); a subagent has none. The
 *  panel yields to the thread: it shrinks so the thread keeps `THREAD_MIN`,
 *  and in a row too narrow for `PANEL_MIN` beside it, it is not drawn (its
 *  open state stays, so it returns when the row widens). A toggle in place
 *  moves it (`usePaneMotion`): the thread takes its new width at once and
 *  the pane slides in from the row's edge, or slides back out over the
 *  thread; a pane that mounts open (a tab switch, a launch) is just there. */
export function ThreadView(props: ThreadViewProps) {
  const { session } = props;
  const master = isMasterThread(session);
  const panel = useRightPanel(session.id);
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const rowWidth = useRowWidth(row);
  // Measured on the row, never the thread column, so the panel's width cannot feed its own measure.
  const fit = rowWidth === null ? panel.width : panelFit(rowWidth, panel.width);
  const root = !session.parentId;
  useEffect(() => {
    if (!root) return;
    rightPanel.setRoom(session.id, fit !== null);
  }, [fit, root, session.id]);
  useEffect(() => (root ? () => rightPanel.setRoom(session.id, true) : undefined), [root, session.id]);
  const pane = usePaneMotion(session.id, panel.open, fit);
  const view = master ? <MasterView {...props} /> : typeView(props);
  if (!root) return view;
  return (
    // Clipped on x alone: the arriving pane never paints over a split's neighbour, and popovers still overflow up.
    <div ref={setRow} className="relative flex min-h-0 min-w-0 flex-1 overflow-x-clip">
      {view}
      {pane.drawn ? (
        <RightPanel
          session={session}
          width={pane.width ?? undefined}
          maxWidth={rowWidth === null ? undefined : rowWidth - THREAD_MIN}
          motion={pane.motion}
          onLeft={pane.onLeft}
          onOpenFile={props.onOpenFile}
          onOpenDiff={props.onOpenDiff}
          onOpenSession={props.onOpenSession}
        />
      ) : null}
    </div>
  );
}

/**
 * Whether the pane is drawn and how it moves. It arrives only when the
 * thread's panel opens while this view shows that thread; once closed it
 * stays drawn, leaving, at the width it had, until its slide ends (or twice
 * the exit's time, for a pane that never paints it). A reopen mid-leave turns
 * the same element back. A row too narrow for it hides it at once.
 */
export function usePaneMotion(id: string, open: boolean, fit: number | null): { drawn: boolean; width: number | null; motion?: PanelMotion; onLeft: () => void } {
  const [was, setWas] = useState({ id, open });
  const [motion, setMotion] = useState<PanelMotion | undefined>(undefined);
  const [held, setHeld] = useState<number | null>(fit);
  if (was.id !== id || was.open !== open) {
    setWas({ id, open });
    setMotion(was.id !== id ? undefined : open ? "arrive" : "leave");
  }
  if (open && fit !== null && fit !== held) setHeld(fit);
  const leaving = !open && motion === "leave" && held !== null;
  const onLeft = (): void => setMotion(undefined);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setMotion(undefined), DUR.fast * 2000);
    return () => clearTimeout(timer);
  }, [leaving]);
  const shown = open && fit !== null;
  return { drawn: shown || leaving, width: shown ? fit : held, motion: shown || leaving ? motion : undefined, onLeft };
}

/** The element's width, following its resizes; null until first measured. */
function useRowWidth(el: HTMLElement | null): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return width;
}

function typeView(props: ThreadViewProps) {
  switch (props.session.threadType) {
    case "planning":
    case "project-plan":
      return <PlanView {...props} />;
    case "implementation":
      return <ImplementationView {...props} />;
    case "research":
      return <ResearchView {...props} />;
    case "orchestration":
      return <OrchestrationView {...props} />;
    default:
      return <ChatView {...props} />;
  }
}
