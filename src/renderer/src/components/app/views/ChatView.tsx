import { Transcript } from '../Transcript'
import { PromptBar } from '../PromptBar'

export function ChatView({ sessionId }: { sessionId: string }): React.JSX.Element {
  return (
    <>
      <Transcript sessionId={sessionId} />
      <PromptBar />
    </>
  )
}
