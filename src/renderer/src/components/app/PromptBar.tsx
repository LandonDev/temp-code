import { useState } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { useApp } from '../../state/store'
import { StatefulButton } from '../motion/button/stateful'

/**
 * The send button morphs into Stop while a turn runs (BeUI stateful button,
 * one motion vocabulary — docs/PLAN.md M3). Typing stays enabled while
 * running: the harness queues messages natively, and the user-text event
 * lands in the transcript immediately.
 */
export function PromptBar(): React.JSX.Element | null {
  const selectedId = useApp((s) => s.selectedId)
  const session = useApp((s) => (s.selectedId ? s.sessions[s.selectedId] : undefined))
  const send = useApp((s) => s.send)
  const interrupt = useApp((s) => s.interrupt)
  const [text, setText] = useState('')

  if (!selectedId || !session) return null
  const running = session.status === 'running'

  const submit = (): void => {
    const t = text.trim()
    if (!t) return
    setText('')
    void send(selectedId, t)
  }

  return (
    <div className="border-t px-6 py-3">
      <div className="flex items-end gap-2 rounded-lg border bg-card px-3 py-2 focus-within:ring-1 focus-within:ring-ring">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          rows={Math.min(6, Math.max(1, text.split('\n').length))}
          placeholder={`Message ${session.model}…`}
          className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <StatefulButton
          size="sm"
          icon={running ? <Square className="size-3" /> : <ArrowUp className="size-3.5" />}
          disabled={!running && !text.trim()}
          onClick={() => {
            if (running) void interrupt(selectedId)
            else submit()
          }}
        >
          {running ? 'Stop' : 'Send'}
        </StatefulButton>
      </div>
    </div>
  )
}
