import { useRef, useState } from 'react'
import { AnimatePresence, Reorder, useReducedMotion } from 'motion/react'
import type { QueuedMessage } from '../lib/tcserver/types'
import { queueTune, type QueueTune } from '../lib/tcserver/commands'
import { useSessionMeta } from '../lib/tcserver/store'
import { modelsFor, resolveModel } from '../lib/models'
import { HARNESSES, HARNESS_TITLE, type HarnessId } from '../lib/session'
import { HarnessIcon } from './HarnessIcon'
import { Popover } from './Popover'
import { Select } from '../surfaces/settingsBits'
import { ArrowUp, GripVertical, SlidersHorizontal, X } from './icons'

type Props = {
  items: QueuedMessage[]
  /** The thread the queue belongs to; with it each row's model is editable. */
  sessionId?: string
  /** The turn is paused: rows wait for Continue, so ↑ is hidden. */
  paused?: boolean
  onSteer: (messageId: string) => void
  onRemove: (messageId: string) => void
  onUpdate: (messageId: string, text: string) => void
  onReorder: (order: string[]) => void
}

/**
 * Messages waiting their turn, stacked above the composer. Each sends as
 * turns settle, in order. Drag to reorder, click the text to edit in
 * place, ✕ removes, ↑ steers it into the running turn now (providers that
 * cannot steer send it next instead).
 */
export function MessageQueue({
  items,
  sessionId,
  paused,
  onSteer,
  onRemove,
  onUpdate,
  onReorder
}: Props) {
  const [editing, setEditing] = useState<string | null>(null)
  const reduce = useReducedMotion()

  if (items.length === 0) return null

  return (
    <div className="mb-2">
      <p className="mb-1 px-1 text-[11px] font-medium tracking-[0.08em] text-content/50 uppercase">
        Queued · {items.length}
      </p>
      <Reorder.Group
        axis="y"
        values={items.map((m) => m.id)}
        onReorder={(order) => onReorder(order as string[])}
        className="flex flex-col gap-1"
      >
        <AnimatePresence initial={false}>
          {items.map((m, ix) => (
            <Reorder.Item
              key={m.id}
              value={m.id}
              initial={reduce ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? undefined : { opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
              className="group/q relative"
            >
              <div className="flex items-start gap-1.5 rounded-lg border border-content/10 bg-content/3 py-1.5 pr-1.5 pl-1">
                <span className="mt-[3px] cursor-grab text-content/30 active:cursor-grabbing">
                  <GripVertical className="size-3.5" />
                </span>
                {editing === m.id ? (
                  <textarea
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
                    className="min-w-0 flex-1 resize-none bg-transparent text-[12.5px] leading-5 text-content outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setEditing(m.id)}
                    title="Edit"
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="line-clamp-2 text-[12.5px] leading-5 text-content/60">
                      <span className="mr-1.5 text-[10.5px] text-content/35 tabular-nums">
                        {ix + 1}
                      </span>
                      {m.text}
                    </span>
                  </button>
                )}
                <span className="flex shrink-0 items-center gap-0.5">
                  {sessionId ? <QueueTuneButton sessionId={sessionId} item={m} /> : null}
                  <span className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/q:opacity-100 focus-within:opacity-100">
                    {paused ? null : (
                      <button
                        type="button"
                        onClick={() => onSteer(m.id)}
                        aria-label="Send now"
                        title="Send now, into the running turn"
                        className="flex size-5 items-center justify-center rounded text-content/60 transition hover:bg-content/10 hover:text-content active:scale-[0.96]"
                      >
                        <ArrowUp className="size-3" strokeWidth={2.25} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onRemove(m.id)}
                      aria-label="Remove from queue"
                      className="flex size-5 items-center justify-center rounded text-content/60 transition hover:bg-content/10 hover:text-content active:scale-[0.96]"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                </span>
              </div>
            </Reorder.Item>
          ))}
        </AnimatePresence>
      </Reorder.Group>
    </div>
  )
}

const EFFORT_LABEL: Record<string, string> = { xhigh: 'Extra High' }
const effortLabel = (value: string) =>
  EFFORT_LABEL[value] ?? value[0].toUpperCase() + value.slice(1)

/**
 * A queued message's own run settings. Unset fields follow the thread at
 * send time; a set one shows on the row and is edited in the popover.
 */
function QueueTuneButton({ sessionId, item }: { sessionId: string; item: QueuedMessage }) {
  const meta = useSessionMeta(sessionId)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const overridden = !!(item.provider || item.model || item.reasoning)
  const harness = (item.provider ?? meta?.provider ?? 'claude') as HarnessId
  const modelId = item.model ?? meta?.model ?? ''
  const model = resolveModel(harness, modelId)
  const effortOptions = model.settings?.find((setting) => setting.id === 'effort')?.options ?? []
  const reasoning = item.reasoning ?? meta?.reasoning ?? ''
  const harnesses = HARNESSES.filter((id) => modelsFor(id).length > 0)

  const apply = (patch: QueueTune) =>
    void queueTune(sessionId, item.id, patch).catch(() => undefined)
  const setHarness = (next: HarnessId) => {
    const first = modelsFor(next)[0]
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
    const next = resolveModel(harness, nativeId)
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

  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label="Model for this message"
        aria-expanded={open}
        title={overridden ? `${HARNESS_TITLE[harness]} · ${model.name}` : 'Model for this message'}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((value) => !value)}
        className={`flex h-5 items-center gap-1 rounded px-1 text-[10.5px] transition hover:bg-content/10 hover:text-content ${
          overridden
            ? 'text-content/70'
            : 'text-content/60 opacity-0 group-hover/q:opacity-100 focus-visible:opacity-100'
        } ${open ? 'opacity-100 bg-content/10' : ''}`}
      >
        {overridden ? (
          <>
            <HarnessIcon harness={harness} className="size-3 shrink-0" />
            <span className="max-w-28 truncate">
              {model.name}
              {item.reasoning ? ` · ${effortLabel(item.reasoning)}` : ''}
            </span>
          </>
        ) : (
          <SlidersHorizontal className="size-3" strokeWidth={2} />
        )}
      </button>
      {open ? (
        <Popover
          anchor={anchor}
          side="top"
          align="end"
          width={240}
          onDismiss={() => setOpen(false)}
          role="dialog"
          aria-label="Model for this message"
          data-queue-tune
          className="flex flex-col gap-2 p-2"
        >
          <label className="flex items-center justify-between gap-2 text-[11px] text-content/60">
            Provider
            <Select
              label="Provider"
              value={harness}
              options={harnesses.map((id) => ({ value: id, label: HARNESS_TITLE[id] }))}
              onChange={(value) => setHarness(value as HarnessId)}
            />
          </label>
          <label className="flex items-center justify-between gap-2 text-[11px] text-content/60">
            Model
            <Select
              label="Model"
              value={model.nativeId ?? modelId}
              options={modelsFor(harness).map((m) => ({
                value: m.nativeId ?? m.id,
                label: m.name
              }))}
              onChange={setModel}
            />
          </label>
          {effortOptions.length > 0 ? (
            <label className="flex items-center justify-between gap-2 text-[11px] text-content/60">
              Reasoning
              <Select
                label="Reasoning"
                value={
                  effortOptions.some((o) => o.value === reasoning)
                    ? reasoning
                    : effortOptions[0].value
                }
                options={effortOptions}
                onChange={(value) =>
                  apply({ provider: harness, model: model.nativeId ?? modelId, reasoning: value })
                }
              />
            </label>
          ) : null}
          {overridden ? (
            <button
              type="button"
              onClick={() => {
                apply({ provider: null, model: null, reasoning: null })
                setOpen(false)
              }}
              className="self-start rounded-md px-1.5 py-1 text-[11px] text-content/60 hover:bg-content/10 hover:text-content"
            >
              Follow the thread
            </button>
          ) : null}
        </Popover>
      ) : null}
    </>
  )
}
