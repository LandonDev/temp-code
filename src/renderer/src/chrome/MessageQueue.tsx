import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useSortable } from '../hooks/useSortable'
import { DUR, EASE_OUT, FADE_OUT } from '../lib/ease'
import type { QueuedMessage } from '../lib/tcserver/types'
import { queueTune, type QueueTune } from '../lib/tcserver/commands'
import { useSessionMeta } from '../lib/tcserver/store'
import { effortWord, modelsFor, resolveModel } from '../lib/models'
import { HARNESSES, HARNESS_TITLE, type HarnessId } from '../lib/session'
import { HarnessIcon } from './HarnessIcon'
import { Button } from '../components/ui/button'
import { reveal } from '../components/ui/reveal'
import { Textarea } from '../components/ui/textarea'
import { ChoiceSelect } from '../components/choice-select'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/lazy-menus'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { ArrowUp, GripVertical, SlidersHorizontal, X } from './icons'

type Props = {
  items: QueuedMessage[]
  /** The thread the queue belongs to; with it each row's model is editable. */
  sessionId?: string
  /** The turn is paused: rows wait for Continue, so ↑ is hidden. */
  paused?: boolean
  /** The thread is queued: its stored first message is the transcript's row, not a row here. */
  queued?: boolean
  onSteer: (messageId: string) => void
  onRemove: (messageId: string) => void
  onUpdate: (messageId: string, text: string) => void
  onReorder: (order: string[]) => void
}

/** The items the queue shows. On a queued thread a stored item (the
 *  held-back boot's first message, already the transcript's user row) is
 *  left to the transcript; anywhere else every item shows, its controls
 *  with it (a retry the harness refused is removed or edited here). */
export function visibleQueue(items: readonly QueuedMessage[], queued: boolean): QueuedMessage[] {
  return queued ? items.filter((m) => !m.stored) : [...items]
}

/** The whole queue's order after the shown rows were reordered: a hidden
 *  item keeps its place, the shown ids fill the rest in their new order
 *  (the host puts an id left out at the end, which would send the thread's
 *  first message after its follow-ups). */
export function mergeOrder(items: readonly QueuedMessage[], shown: readonly string[]): string[] {
  const hidden = new Set(items.map((m) => m.id))
  for (const id of shown) hidden.delete(id)
  const queue = [...shown]
  return items.map((m) => (hidden.has(m.id) ? m.id : (queue.shift() ?? m.id)))
}

/** The rows in the order the person dropped them while the host's answer
 *  is on its way: an order made against the rows as they are now, else the
 *  rows as the host has them. */
export function droppedOrder<T extends { id: string }>(rows: readonly T[], dropped: { base: string; order: string[] } | null): T[] {
  if (!dropped || dropped.base !== rows.map((m) => m.id).join('\u0000')) return [...rows]
  const byId = new Map(rows.map((m) => [m.id, m]))
  return dropped.order.flatMap((id) => byId.get(id) ?? [])
}

/** How long a dropped order stands without the host's answer before the
 *  rows go back to the host's order (a reorder it refused). */
const DROP_HOLD_MS = 2_000

/**
 * Messages waiting their turn, stacked above the composer. Each sends as
 * turns settle, in order. Drag a row by its grip to reorder (hooks/useSortable,
 * the rule of every list: only the dragged row moves, the others hold with
 * the insertion line, the drop glides into its slot on SPRING_GLIDE, Escape
 * glides it back), click the text to edit in place, Remove takes it out,
 * Send now steers it into the running turn (providers that cannot steer send
 * it next instead). A stored item shows nothing here: its row is on the
 * transcript.
 */
export function MessageQueue({
  items,
  sessionId,
  paused,
  queued,
  onSteer,
  onRemove,
  onUpdate,
  onReorder
}: Props) {
  const [editing, setEditing] = useState<string | null>(null)
  const reduce = useReducedMotion()
  // The thread sits in a wait_for_agent: the list drains when the wait does.
  const awaiting = (useSessionMeta(sessionId)?.awaiting?.length ?? 0) > 0
  const host = visibleQueue(items, !!queued)
  // A drop shows its order at once; the host's push replaces it.
  const [dropped, setDropped] = useState<{ base: string; order: string[] } | null>(null)
  const shown = droppedOrder(host, dropped)
  useEffect(() => {
    if (!dropped) return
    const timer = window.setTimeout(() => setDropped(null), DROP_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [dropped])
  const ids = shown.map((m) => m.id)
  const sortable = useSortable(
    ids,
    (order) => {
      setDropped({ base: host.map((m) => m.id).join('\u0000'), order })
      onReorder(mergeOrder(items, order))
    },
    'y'
  )

  if (shown.length === 0) return null

  return (
    <div className="mb-2">
      <p className="mb-1 px-1.5 text-xs font-medium text-muted-foreground">
        {awaiting ? (
          'Queued until the wait finishes'
        ) : (
          <>
            Queued<span className="ms-1 tabular-nums">{shown.length}</span>
          </>
        )}
      </p>
      <div data-queue-list className="flex flex-col gap-1">
        <AnimatePresence initial={false}>
          {shown.map((m, ix) => {
            const dropping = sortable.toIndex === ix && sortable.fromIndex !== null && sortable.toIndex !== sortable.fromIndex
            return (
              <motion.div
                key={m.id}
                ref={(el: HTMLDivElement | null) => sortable.setItemRef(m.id, el)}
                data-queue-row={m.id}
                // A full transform string, so the entry runs on the compositor (motion's `y` is main-thread).
                initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(4px)' }}
                animate={
                  reduce
                    ? { opacity: 1, transition: { duration: DUR.fast, ease: EASE_OUT } }
                    : { opacity: 1, transform: 'translateY(0px)', transition: { duration: DUR.base, ease: EASE_OUT } }
                }
                exit={FADE_OUT}
                className={`group/q relative ${sortable.draggingId === m.id ? 'z-10' : ''}`}
              >
                {dropping ? (
                  <div
                    data-queue-drop
                    className={`pointer-events-none absolute inset-x-2 z-20 h-0.5 rounded-full bg-accent ${sortable.toIndex! < sortable.fromIndex! ? 'top-0' : 'bottom-0'}`}
                  />
                ) : null}
                <div className="flex items-start gap-1.5 rounded-lg border border-border bg-card py-1.5 pr-1.5 pl-1">
                  <span
                    data-queue-grip
                    aria-hidden
                    onPointerDown={(event) => sortable.onItemPointerDown(m.id, event)}
                    className="-my-1.5 -ms-1 flex shrink-0 cursor-grab touch-none self-stretch py-1.5 ps-1 text-muted-foreground/60 active:cursor-grabbing"
                  >
                    <GripVertical className="mt-[3px] size-3.5" />
                  </span>
                  {editing === m.id ? (
                    <Textarea
                      autoFocus
                      defaultValue={m.text}
                      rows={Math.min(4, m.text.split('\n').length)}
                      onFocus={(e) =>
                        e.currentTarget.setSelectionRange(
                          e.currentTarget.value.length,
                          e.currentTarget.value.length
                        )
                      }
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          e.currentTarget.blur()
                        }
                        if (e.key === 'Escape') {
                          e.currentTarget.value = m.text
                          e.currentTarget.blur()
                        }
                      }}
                      onBlur={(e) => {
                        setEditing(null)
                        const v = e.target.value.trim()
                        if (v && v !== m.text) onUpdate(m.id, v)
                      }}
                      aria-label="Edit queued message"
                      className="field-sizing-fixed min-h-0 min-w-0 flex-1 resize-none rounded-none border-0 px-0 py-0 leading-5 text-foreground focus-within:shadow-none"
                    />
                  ) : (
                    <Button
                      variant="ghost"
                      aria-label={`Edit: ${m.text}`}
                      onClick={() => setEditing(m.id)}
                      className="h-auto min-w-0 flex-1 justify-start whitespace-normal px-0 py-0 text-left font-normal hover:bg-transparent aria-expanded:bg-transparent active:bg-transparent"
                    >
                      <span className="line-clamp-2 text-[13px] leading-5 text-foreground">
                        <span className="me-1 text-xs tabular-nums text-muted-foreground">
                          {ix + 1}
                        </span>
                        {m.text}
                      </span>
                    </Button>
                  )}
                  <span className="flex shrink-0 items-center gap-0.5">
                    {sessionId ? <QueueTuneButton sessionId={sessionId} item={m} /> : null}
                    <span className={`flex items-center gap-0.5 ${reveal('q')}`}>
                      {paused ? null : (
                        <RowAction label="Send now" onClick={() => onSteer(m.id)}>
                          <ArrowUp />
                        </RowAction>
                      )}
                      <RowAction label="Remove" ariaLabel="Remove from queue" onClick={() => onRemove(m.id)}>
                        <X />
                      </RowAction>
                    </span>
                  </span>
                </div>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </div>
  )
}

/**
 * A queued message's own run settings. Unset fields follow the thread at
 * send time; a set one shows on the row and is edited in the popover.
 */
function QueueTuneButton({ sessionId, item }: { sessionId: string; item: QueuedMessage }) {
  const meta = useSessionMeta(sessionId)
  const [open, setOpen] = useState(false)
  const overridden = !!(item.provider || item.model || item.reasoning)
  const harness = (item.provider ?? meta?.provider ?? 'claude') as HarnessId
  const modelId = item.model ?? meta?.model ?? ''
  const environmentId = meta?.environmentId
  const model = resolveModel(harness, modelId, environmentId)
  const effortOptions = model.settings?.find((setting) => setting.id === 'effort')?.options ?? []
  const reasoning = item.reasoning ?? meta?.reasoning ?? ''
  const harnesses = HARNESSES.filter((id) => modelsFor(id, environmentId).length > 0)

  const apply = (patch: QueueTune) =>
    void queueTune(sessionId, item.id, patch).catch(() => undefined)
  const setHarness = (next: HarnessId) => {
    const first = modelsFor(next, environmentId)[0]
    if (!first) return
    const effort = first.settings?.find((setting) => setting.id === 'effort')
    apply({
      provider: next,
      model: first.nativeId ?? first.id,
      reasoning: effort
        ? effort.options.some((o) => o.value === reasoning)
          ? reasoning
          : effort.value
        : null
    })
  }
  const setModel = (nativeId: string) => {
    const next = resolveModel(harness, nativeId, environmentId)
    const effort = next.settings?.find((setting) => setting.id === 'effort')
    apply({
      provider: harness,
      model: nativeId,
      reasoning: effort
        ? effort.options.some((o) => o.value === reasoning)
          ? reasoning
          : effort.value
        : null
    })
  }

  const trigger = (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label="Model for this message"
                  className="relative h-5 px-1 text-xs font-normal text-muted-foreground after:absolute after:inset-x-0 after:-inset-y-0.5 after:content-[''] hover:text-foreground"
                />
              }
            />
          }
        >
          {overridden ? (
            <>
              <HarnessIcon harness={harness} className="size-3 shrink-0" />
              <span className="max-w-28 truncate">{model.name}</span>
              {item.reasoning ? <span className="ms-1">{effortWord(item.reasoning)}</span> : null}
            </>
          ) : (
            <SlidersHorizontal className="size-3" />
          )}
        </TooltipTrigger>
        <TooltipContent>Model for this message</TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="end" data-queue-tune aria-label="Model for this message" className="w-64 gap-1 p-2">
        <TuneRow label="Provider">
          <ChoiceSelect
            size="sm"
            label="Provider"
            value={harness}
            options={harnesses.map((id) => ({ value: id, label: HARNESS_TITLE[id] }))}
            onChange={(value) => setHarness(value as HarnessId)}
          />
        </TuneRow>
        <TuneRow label="Model">
          <ChoiceSelect
            size="sm"
            label="Model"
            value={model.nativeId ?? modelId}
            options={modelsFor(harness, environmentId).map((m) => ({ value: m.nativeId ?? m.id, label: m.name }))}
            onChange={setModel}
          />
        </TuneRow>
        {effortOptions.length > 0 ? (
          <TuneRow label="Effort">
            <ChoiceSelect
              size="sm"
              label="Effort"
              value={effortOptions.some((o) => o.value === reasoning) ? reasoning : effortOptions[0].value}
              options={effortOptions}
              onChange={(value) => apply({ provider: harness, model: model.nativeId ?? modelId, reasoning: value })}
            />
          </TuneRow>
        ) : null}
        {overridden ? (
          <Button
            variant="ghost"
            size="xs"
            className="self-start font-normal text-muted-foreground"
            onClick={() => {
              apply({ provider: null, model: null, reasoning: null })
              setOpen(false)
            }}
          >
            Follow the thread
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
  // A tuned message shows its settings at rest; an untuned one shows the
  // button on the queue's hover reveal, held while its popover is open.
  return overridden ? trigger : <span className={`flex ${reveal('q')}`}>{trigger}</span>
}

function TuneRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-8 items-center justify-between gap-2">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

/** A row's hover action: a ghost icon button with its name in a Tooltip. */
function RowAction({
  label,
  ariaLabel = label,
  onClick,
  children
}: {
  label: string
  ariaLabel?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={ariaLabel}
            onClick={onClick}
            className="text-muted-foreground hover:text-foreground"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
