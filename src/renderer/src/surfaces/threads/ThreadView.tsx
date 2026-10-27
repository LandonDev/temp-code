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
import { RightPanel } from "../RightPanel";

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
 *  panel at its edge (surfaces/RightPanel.tsx); a subagent has none. */
export function ThreadView(props: ThreadViewProps) {
  const { session } = props;
  const master = isMasterThread(session);
  const view = master ? <MasterView {...props} /> : typeView(props);
  if (session.parentId) return view;
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      {view}
      <RightPanel
        session={session}
        onOpenFile={props.onOpenFile}
        onOpenDiff={props.onOpenDiff}
        onOpenSession={props.onOpenSession}
      />
    </div>
  );
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
