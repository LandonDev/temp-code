import type { ReactNode } from "react";
import type { OpenFileFn } from "../../lib/search";
import type { Session } from "../../lib/session";
import { ChatView } from "./ChatView";
import { ImplementationView } from "./ImplementationView";
import { OrchestrationView } from "./OrchestrationView";
import { PlanView } from "./PlanView";
import { ResearchView } from "./ResearchView";

/** What a view may ask of the chat column it is handed. */
export type ChatOpts = {
  /** Rides the composer's top edge (the pass banner). */
  topSlot?: ReactNode;
};

export type ThreadViewProps = {
  session: Session;
  /** Builds the transcript + strip + composer column; call it once per render. */
  renderChat: (opts?: ChatOpts) => ReactNode;
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
