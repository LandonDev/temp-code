import { FleetPanel, FleetPulseLine } from '../AgentFleet'
import { Transcript } from '../Transcript'
import { PromptBar } from '../PromptBar'
import { WorkingStrip } from '../WorkingStrip'

/**
 * Chat thread. Spawning subagents grows the fleet panel on the right — the
 * same rows and drill-in the implementation board uses — while the chat
 * slides left and keeps streaming. The panel follows the fleet (opens
 * live, folds to an edge tab when every agent settles); the pulse line
 * keeps the thread reading as busy while its fleet works.
 */
export function ChatView({ sessionId }: { sessionId: string }): React.JSX.Element {
  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Transcript sessionId={sessionId} />
        <FleetPulseLine sessionId={sessionId} />
        <WorkingStrip sessionId={sessionId} />
        <PromptBar />
      </div>
      <FleetPanel sessionId={sessionId} />
    </div>
  )
}
