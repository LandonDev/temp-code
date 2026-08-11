import { useState } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { useApp } from '../../state/store'

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
        {running ? (
          <button
            onClick={() => void interrupt(selectedId)}
            className="rounded-md bg-secondary p-1.5 hover:bg-accent"
            title="Interrupt"
          >
            <Square className="size-3.5" />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!text.trim()}
            className="rounded-md bg-primary p-1.5 text-primary-foreground disabled:opacity-40"
            title="Send"
          >
            <ArrowUp className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}
