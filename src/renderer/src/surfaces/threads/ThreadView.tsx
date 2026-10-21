import type { OpenFileFn } from "../../lib/search";
import type { Session } from "../../lib/session";
import type { ChatSource } from "./chatSlots";
import { ChatView } from "./ChatView";
import { threadViewsChunk } from "../chunks";
import { SurfaceSkeleton } from "../SurfaceSkeleton";

// Every view but the chat rides the thread-views chunk (surfaces/chunks.ts),
// preloaded in the idle slot after the first thread opens (SessionPane).
const skeleton = <SurfaceSkeleton kind="pane" label="Loading thread" />;
const ImplementationView = threadViewsChunk.surface("ImplementationView", skeleton);
const OrchestrationView = threadViewsChunk.surface("OrchestrationView", skeleton);
const PlanView = threadViewsChunk.surface("PlanView", skeleton);
const ResearchView = threadViewsChunk.surface("ResearchView", skeleton);

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

/** The switch on a session's thread type; null and chat fall through to ChatView. */
export function ThreadView(props: ThreadViewProps) {
  const { session } = props;
  switch (session.threadType) {
    case "planning":
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
