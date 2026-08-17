import { useState } from 'react'
import { Target } from 'lucide-react'
import type { SessionMeta } from '@shared/events'
import { useApp } from '../../state/store'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/**
 * The prompt bar's goal control (claude and codex threads; cursor has no
 * goal support so the caller hides it). One ◎ button — plain when no goal,
 * tinted while one is active — opening a popover that sets, updates or
 * clears the condition. The tint never moves optimistically: the harness
 * confirms with a goal event and the folded SessionMeta.goal flips it.
 */
export function GoalControl({
  sessionId,
  goal
}: {
  sessionId: string
  goal: SessionMeta['goal']
}): React.JSX.Element {
  const setGoal = useApp((s) => s.setGoal)
  const clearGoal = useApp((s) => s.clearGoal)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const active = !!goal
  const condition = text.trim()
  const changed = condition !== (goal?.condition ?? '')

  const run = (fn: () => Promise<void>): void => {
    setBusy(true)
    setError(null)
    fn()
      .then(() => setOpen(false))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) {
          setText(goal?.condition ?? '')
          setError(null)
        }
      }}
    >
      <PopoverTrigger
        aria-label={active ? `Goal: ${goal.condition}` : 'Set a goal'}
        title={active ? goal.condition : 'Set a goal'}
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-full transition-colors duration-150 active:scale-95',
          active
            ? 'bg-primary/10 text-primary hover:bg-primary/15'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        )}
      >
        <Target className="size-[15px]" strokeWidth={active ? 2.25 : 2} />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-2 p-2.5">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (condition && changed && !busy) run(() => setGoal(sessionId, condition))
            }
          }}
          placeholder="Keep working until…"
          rows={2}
          autoFocus
          className="max-h-32 min-h-[52px] w-full resize-none rounded-lg border border-border/60 bg-background/40 px-2.5 py-2 text-[12.5px] leading-snug outline-none placeholder:text-muted-foreground/60 focus:border-border"
        />
        {error && <p className="text-[12px] text-destructive">{error}</p>}
        <div className="flex items-center gap-2">
          {active && goal.iterations > 0 && (
            <span className="text-[11.5px] text-muted-foreground">
              Checked {goal.iterations}×
            </span>
          )}
          <span className="flex-1" />
          {active && (
            <button
              onClick={() => run(() => clearGoal(sessionId))}
              disabled={busy}
              className="rounded-lg px-2.5 py-1 text-[12.5px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground active:scale-[0.98] disabled:opacity-50"
            >
              Clear
            </button>
          )}
          <button
            onClick={() => run(() => setGoal(sessionId, condition))}
            disabled={!condition || !changed || busy}
            className="rounded-lg bg-primary px-2.5 py-1 text-[12.5px] font-medium text-primary-foreground transition hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
          >
            {busy ? 'Setting…' : active ? 'Update' : 'Set'}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
