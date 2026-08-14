import { Transcript } from '../Transcript'
import { PromptBar } from '../PromptBar'
import { WorkingStrip } from '../WorkingStrip'

export function ChatView({ sessionId }: { sessionId: string }): React.JSX.Element {
  return (
    <>
      <Transcript sessionId={sessionId} />
      <WorkingStrip sessionId={sessionId} />
      <PromptBar />
    </>
  )
}
