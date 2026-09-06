import { FleetSlot } from "./FleetSlot";
import { FleetPulseLine } from "./fleet/FleetPanel";
import type { ThreadViewProps } from "./ThreadView";

export function ChatView(props: ThreadViewProps) {
  const { session } = props;
  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {props.renderChat({ topSlot: <FleetPulseLine sessionId={session.id} /> })}
      </div>
      <FleetSlot
        sessionId={session.id}
        parentCwd={session.cwd}
        onOpenSession={props.onOpenSession}
        onOpenFile={props.onOpenFile}
        onOpenDiff={props.onOpenDiff}
      />
    </div>
  );
}
