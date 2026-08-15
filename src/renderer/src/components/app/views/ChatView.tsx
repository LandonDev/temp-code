import { Transcript } from '../Transcript'
import { PromptBar } from '../PromptBar'
import { WorkingStrip } from '../WorkingStrip'

export function ChatView({ sessionId }: { sessionId: string }): React.JSX.Element {
  return (
    <>
      {/* Keyed: a tab switch remounts the transcript (clean scroll state)
          behind a quick cross-fade instead of an instant content swap. */}
      <Transcript
        key={sessionId}
        sessionId={sessionId}
        className="animate-[z-fade-quick_150ms_ease-out]"
      />
      <WorkingStrip sessionId={sessionId} />
      <PromptBar />
    </>
  )
}
