import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import type { ThreadResource } from '@server/shared/contract-resources'
import {
  KIND_LABEL,
  archiveThread,
  hostName,
  loadThreadResources,
  removalClause,
  removeThreadResources,
  rowState,
  useThreadResources
} from '../lib/threadResources'
import { openUrl, portLine, rowOpen } from '../lib/devPorts'
import { macBridgeStore } from '../lib/macBridge'
import { DialogFooter, errorText } from './ConfirmDialog'
import { Modal } from './Modal'
import { MatrixSpinner } from '../surfaces/threads/spinners'

/**
 * Thread resources (docs/box.md "Thread resources"): the thread menu's
 * "Resources…" panel, one row per worktree, simulator or dev instance the
 * thread created, with where it lives and Remove; and the archive confirm
 * that offers to remove them with the thread. Both read the same store
 * (lib/threadResources.ts), so a removal's outcome lands on the row as the
 * host reports it.
 */

function ResourceRow({ row, onRemove, pending }: { row: ThreadResource; onRemove: () => void; pending: boolean }) {
  const localId = useStore(macBridgeStore, (s) => s.localId)
  // A dev server's line is where it opens here; the ledger's note only when it has one.
  const state = rowState(row) ?? portLine(row, localId)
  const open = rowOpen(row, localId)
  const waiting = !!row.removeRequestedAt && !row.removedAt
  return (
    <div className="flex items-center gap-3" data-resource={row.id}>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1.5 text-[12px] text-content/80">
          <span className="shrink-0 text-content/50">{hostName(row.environmentId)}</span>
          <span className="shrink-0 text-content/40">·</span>
          <span className="shrink-0 text-content/50">{KIND_LABEL[row.kind]}</span>
          <span className="min-w-0 truncate font-mono text-content/90" title={row.identifier}>
            {row.label}
          </span>
        </div>
        {state ? (
          <div className="truncate text-[11px] text-content/45" title={state}>
            {state}
          </div>
        ) : null}
      </div>
      {open ? (
        <button
          type="button"
          onClick={() => openUrl(open.url)}
          title={open.url}
          className="pressable shrink-0 rounded-md px-2 py-0.5 text-[11px] text-content/70 hover:bg-content/8 hover:text-content"
        >
          {open.label}
        </button>
      ) : null}
      <button
        type="button"
        disabled={pending || waiting}
        onClick={onRemove}
        className="pressable flex shrink-0 items-center gap-1.5 rounded-md border border-content/10 px-2 py-0.5 text-[11px] text-danger hover:border-danger/40 hover:bg-danger/10 disabled:cursor-default disabled:opacity-40"
      >
        {pending || waiting ? <MatrixSpinner cell={1.5} /> : null}
        {waiting ? 'Waiting' : row.kind === 'port' ? 'Stop' : 'Remove'}
      </button>
    </div>
  )
}

/** The rows of one thread with Remove per row and Remove all. */
export function ThreadResourceList({ sessionId, empty }: { sessionId: string; empty?: string }) {
  const rows = useThreadResources(sessionId)
  const [pending, setPending] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  const remove = async (ids?: string[]) => {
    setError(null)
    const marked = ids ?? rows.map((r) => r.id)
    setPending((p) => new Set([...p, ...marked]))
    try {
      const results = await removeThreadResources(sessionId, ids)
      const failed = results.filter((r) => r.outcome === 'failed')
      if (failed.length) setError(failed.map((f) => f.note ?? 'failed').join('\n'))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setPending((p) => {
        const next = new Set(p)
        for (const id of marked) next.delete(id)
        return next
      })
    }
  }
  if (rows.length === 0) return empty ? <p className="text-[12px] text-content/40">{empty}</p> : null
  return (
    <div className="flex flex-col gap-1.5" data-thread-resources={sessionId}>
      {rows.map((row) => (
        <ResourceRow key={row.id} row={row} pending={pending.has(row.id)} onRemove={() => void remove([row.id])} />
      ))}
      {rows.length > 1 ? (
        <div className="flex justify-end pt-1">
          <button
            type="button"
            className="pressable rounded-md px-2 py-0.5 text-[11px] text-danger hover:bg-danger/10"
            onClick={() => void remove()}
          >
            Remove all
          </button>
        </div>
      ) : null}
      {error ? <p className="whitespace-pre-wrap text-[11px] text-danger">{error}</p> : null}
    </div>
  )
}

/** The thread menu's "Resources…". */
export function ThreadResourcesDialog({ sessionId, title, onClose }: { sessionId: string; title: string; onClose: () => void }) {
  useEffect(() => void loadThreadResources(sessionId), [sessionId])
  return (
    <Modal onClose={onClose} title={`Resources · ${title}`} size="md">
      <div className="flex flex-col gap-3 px-4 py-3">
        <p className="text-[12px] leading-snug text-content/50">
          What this thread created and where: git worktrees, simulators, dev instances and dev servers, on its host or on the Mac.
          Remove runs on that host as the thread; a branch with commits nowhere else stays, and the row says so.
        </p>
        <ThreadResourceList sessionId={sessionId} empty="Nothing recorded: this thread created no worktrees, simulators, dev instances or dev servers." />
      </div>
    </Modal>
  )
}

/** Archive, offering to remove the thread's resources with it (the box is on by default). */
export function ArchiveThreadDialog({
  sessionId,
  title,
  resources,
  onCancel,
  onArchived
}: {
  sessionId: string
  title: string
  resources: readonly ThreadResource[]
  onCancel: () => void
  onArchived: () => void
}) {
  const [remove, setRemove] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirm = async () => {
    setPending(true)
    setError(null)
    try {
      await archiveThread(sessionId, { removeResources: remove })
      onArchived()
    } catch (err) {
      setError(errorText(err))
      setPending(false)
    }
  }
  return (
    <Modal onClose={onCancel} busy={pending} title={`Archive ${title}?`} size="sm">
      <div className="flex flex-col gap-2.5 px-4 py-3">
        <label className="flex items-start gap-2 text-[12px] leading-snug text-content/80">
          <input type="checkbox" className="mt-0.5" checked={remove} onChange={(e) => setRemove(e.target.checked)} data-remove-resources />
          <span>{removalClause(resources)}</span>
        </label>
        <ul className="flex flex-col gap-0.5 pl-6 text-[11px] text-content/50">
          {resources.map((r) => (
            <li key={r.id} className="flex min-w-0 items-baseline gap-1.5">
              <span className="shrink-0">{KIND_LABEL[r.kind]}</span>
              <span className="min-w-0 truncate font-mono text-content/70" title={r.identifier}>
                {r.label}
              </span>
            </li>
          ))}
        </ul>
        {error ? <p className="whitespace-pre-wrap text-[11px] leading-4 text-danger">{error}</p> : null}
      </div>
      <DialogFooter onCancel={onCancel} onConfirm={confirm} confirmLabel="Archive" pending={pending} />
    </Modal>
  )
}
