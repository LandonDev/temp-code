import { memo, useState } from 'react'
import { Check, X } from 'lucide-react'
import { useApp } from '../../../state/store'
import type { Block, QuestionSpec } from '../../../state/blocks'
import { cn } from '../../../lib/utils'

type QuestionBlock = Extract<Block, { kind: 'question' }>

/**
 * The model stopped to ask — options as real choices, not an Allow/Deny
 * card. Single-select with one question answers on click; anything more
 * (multi-select, several questions, typed text) confirms explicitly.
 * Violet family: this is the "needs your answer" moment, same as planning.
 */
export const QuestionCard = memo(function QuestionCard({
  block,
  sessionId
}: {
  block: QuestionBlock
  sessionId: string
}): React.JSX.Element {
  const answer = useApp((s) => s.answer)
  // picked[i] = selected labels for question i; other[i] = typed text.
  const [picked, setPicked] = useState<string[][]>(() => block.questions.map(() => []))
  const [other, setOther] = useState<string[]>(() => block.questions.map(() => ''))

  if (block.resolved) {
    return (
      <div className="flex max-w-[95%] items-start gap-2 text-xs text-muted-foreground">
        {block.answers ? (
          <Check className="size-3.5 shrink-0" />
        ) : (
          <X className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0">
          {block.answers
            ? block.questions
                .map((q, i) => {
                  const a = block.answers?.[i]?.join(', ')
                  return a ? `${q.header ?? 'Answered'} — ${a}` : null
                })
                .filter(Boolean)
                .join(' · ') || 'answered'
            : 'question dismissed'}
        </span>
      </div>
    )
  }

  const answerFor = (i: number): string[] => {
    const typed = other[i].trim()
    return typed ? [...picked[i], typed] : picked[i]
  }
  const complete = block.questions.every((_, i) => answerFor(i).length > 0)
  const submit = (answers: string[][] | null): void => {
    void answer(sessionId, block.requestId, answers)
  }
  // One single-select question with nothing typed: a click IS the answer.
  const instant = block.questions.length === 1 && !block.questions[0].multiSelect

  const toggle = (qi: number, label: string, q: QuestionSpec): void => {
    if (instant && !other[0].trim()) {
      submit([[label]])
      return
    }
    setPicked((p) =>
      p.map((sel, i) =>
        i !== qi
          ? sel
          : q.multiSelect
            ? sel.includes(label)
              ? sel.filter((l) => l !== label)
              : [...sel, label]
            : [label]
      )
    )
  }

  return (
    <div className="max-w-[95%] rounded-xl border border-violet/25 bg-violet/[0.04]">
      <div className="flex items-center gap-2 px-4 pt-3">
        <p className="text-[10px] font-semibold tracking-[0.08em] text-violet uppercase">
          Needs your answer
        </p>
        <button
          onClick={() => submit(null)}
          aria-label="Dismiss question"
          title="Dismiss — the model continues without an answer"
          className="ml-auto flex size-5 items-center justify-center rounded text-muted-foreground/60 transition hover:bg-accent hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      </div>

      {block.questions.map((q, qi) => (
        <div key={qi} className={cn('px-4 pb-1', qi > 0 && 'mt-1 border-t border-violet/10 pt-3')}>
          <div className="flex items-start gap-2">
            {q.header && (
              <span className="mt-px shrink-0 rounded bg-violet/10 px-1.5 py-0.5 text-[10px] font-medium text-violet">
                {q.header}
              </span>
            )}
            <p className="text-[13px] leading-snug">{q.question}</p>
          </div>
          <div className="mt-2 flex flex-col gap-1 pb-2">
            {q.options.map((o) => {
              const selected = picked[qi].includes(o.label)
              return (
                <button
                  key={o.label}
                  onClick={() => toggle(qi, o.label, q)}
                  className={cn(
                    'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors active:scale-[0.995]',
                    selected
                      ? 'border-violet/40 bg-violet/10'
                      : 'border-border/60 bg-card hover:bg-accent/40'
                  )}
                >
                  <span
                    className={cn(
                      'mt-[3px] flex size-3.5 shrink-0 items-center justify-center border transition-colors',
                      q.multiSelect ? 'rounded-[4px]' : 'rounded-full',
                      selected ? 'border-violet bg-violet text-white' : 'border-border-strong'
                    )}
                  >
                    {selected && <Check className="size-2.5" strokeWidth={3} />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] leading-snug font-medium">{o.label}</span>
                    {o.description && (
                      <span className="mt-px block text-[11px] leading-4 text-muted-foreground">
                        {o.description}
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
            {q.allowFreeform !== false && (
              <input
                value={other[qi]}
                onChange={(e) => setOther((t) => t.map((v, i) => (i === qi ? e.target.value : v)))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && answerFor(qi).length && complete) {
                    submit(block.questions.map((_, i) => answerFor(i)))
                  }
                }}
                placeholder={q.options.length ? 'Other…' : 'Type an answer…'}
                className="h-8 rounded-lg border border-border/60 bg-card px-3 text-[13px] outline-none placeholder:text-muted-foreground/50 focus:border-violet/40"
              />
            )}
          </div>
        </div>
      ))}

      {!(instant && !other[0]?.trim()) && (
        <div className="flex justify-end border-t border-violet/10 px-3 py-2">
          <button
            disabled={!complete}
            onClick={() => submit(block.questions.map((_, i) => answerFor(i)))}
            className={cn(
              'rounded-lg px-3 py-1.5 text-[13px] font-medium transition active:scale-95',
              complete ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'
            )}
          >
            Answer
          </button>
        </div>
      )}
    </div>
  )
})
