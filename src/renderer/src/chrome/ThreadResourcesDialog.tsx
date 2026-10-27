import { useEffect, useState } from 'react'
import type { ThreadResource } from '@server/shared/contract-resources'
import {
  KIND_LABEL,
  archiveThread,
  hostName,
  isRemovable,
  loadThreadResources,
  removalClause,
  removeThreadResources,
  rowState,
  useThreadResources
} from '../lib/threadResources'
import { LoadingLine } from '../surfaces/SurfaceSkeleton'
import { DialogFooter, ErrorLine, errorText } from './ConfirmDialog'
import { CheckRow } from './DialogField'
import { Tip } from '../components/tip'
import { Modal, ModalBody, useModalClose } from './Modal'

/**
 * Thread resources (docs/box.md "Thread resources"): the thread menu's
 * "Resources…" removal form, one checkbox per worktree, simulator or dev
 * instance the thread created, and one red Remove N; and the archive dialog
 * that offers to remove them with the thread. Both read the same store
 * (lib/threadResources.ts), so a removal's outcome lands as the host reports
 * it. Dev servers are not here: Activity and the dev servers pane list and
 * stop them.
 */

/** One row of the form: its kind, its label (the identifier on hover), and
 *  where it lives with its state, muted. A row its host is still removing
 *  cannot be picked again. */
function ResourceCheck({ row, checked, disabled, onChange }: { row: ThreadResource; checked: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  const state = rowState(row)
  return (
    <CheckRow
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      label={
        <span className="flex min-w-0 items-baseline gap-2" data-resource={row.id}>
          <span className="shrink-0 text-muted-foreground">{KIND_LABEL[row.kind]}</span>
          <Tip label={row.identifier}>
            <span className="min-w-0 truncate font-mono text-xs">{row.label}</span>
          </Tip>
          <span className="shrink-0 text-xs text-muted-foreground">{hostName(row.environmentId)}</span>
          {state ? <span className="min-w-0 truncate text-xs text-muted-foreground">{state}</span> : null}
        </span>
      }
    />
  )
}

/** The thread menu's "Resources…": pick what goes, then Remove N. */
export function ThreadResourcesDialog({ sessionId, title, onClose }: { sessionId: string; title: string; onClose: () => void }) {
  const [pending, setPending] = useState(false)
  return (
    <Modal onClose={onClose} busy={pending} title="Resources" description={title} size="sm">
      <ResourcesForm sessionId={sessionId} onClose={onClose} pending={pending} setPending={setPending} />
    </Modal>
  )
}

function ResourcesForm({
  sessionId,
  onClose,
  pending,
  setPending
}: {
  sessionId: string
  onClose: () => void
  pending: boolean
  setPending: (on: boolean) => void
}) {
  const close = useModalClose()
  const rows = useThreadResources(sessionId).filter(isRemovable)
  const [loaded, setLoaded] = useState(false)
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
  const [removed, setRemoved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void loadThreadResources(sessionId).finally(() => live && setLoaded(true))
    return () => {
      live = false
    }
  }, [sessionId])

  // A removal that leaves nothing behind closes the form: its work is done.
  const empty = rows.length === 0
  useEffect(() => {
    if (removed && empty) close ? close(onClose) : onClose()
  }, [removed, empty]) // eslint-disable-line react-hooks/exhaustive-deps

  const waiting = (row: ThreadResource) => !!row.removeRequestedAt && !row.removedAt
  const chosen = rows.filter((r) => picked.has(r.id) && !waiting(r)).map((r) => r.id)
  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const confirm = async () => {
    if (pending || !chosen.length) return
    setPending(true)
    setError(null)
    try {
      const results = await removeThreadResources(sessionId, chosen)
      const failed = results.filter((r) => r.outcome === 'failed')
      if (failed.length) setError(failed.map((f) => f.note ?? 'failed').join('\n'))
      setPicked(new Set(failed.map((f) => f.id)))
      setRemoved(true)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void confirm()
      }}
    >
      <ModalBody className="gap-2" data-thread-resources={sessionId}>
        {empty && !loaded ? (
          <LoadingLine label="Loading…" />
        ) : empty ? (
          <p className="py-1 text-[13px] text-muted-foreground">Nothing left to remove.</p>
        ) : (
          <div className="flex flex-col">
            {rows.map((row) => (
              <ResourceCheck
                key={row.id}
                row={row}
                checked={picked.has(row.id) && !waiting(row)}
                disabled={pending || waiting(row)}
                onChange={(on) => toggle(row.id, on)}
              />
            ))}
          </div>
        )}
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter
        onCancel={onClose}
        confirmLabel={chosen.length ? `Remove ${chosen.length}` : 'Remove'}
        danger
        pending={pending}
        disabled={!chosen.length}
      />
    </form>
  )
}

type ArchiveProps = {
  sessionId: string
  title: string
  resources: readonly ThreadResource[]
  onCancel: () => void
  onArchived: () => void
}

/** Archive, offering to remove the thread's resources with it (the box is on by default). */
export function ArchiveThreadDialog(props: ArchiveProps) {
  const [pending, setPending] = useState(false)
  return (
    <Modal onClose={props.onCancel} busy={pending} title={`Archive ${props.title}?`} size="sm">
      <ArchiveBody {...props} pending={pending} setPending={setPending} />
    </Modal>
  )
}

function ArchiveBody({
  sessionId,
  resources,
  onCancel,
  onArchived,
  pending,
  setPending
}: ArchiveProps & { pending: boolean; setPending: (on: boolean) => void }) {
  const close = useModalClose()
  const [remove, setRemove] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const confirm = async () => {
    setPending(true)
    setError(null)
    try {
      await archiveThread(sessionId, { removeResources: remove })
      setPending(false)
      if (close) close(onArchived)
      else onArchived()
    } catch (err) {
      setError(errorText(err))
      setPending(false)
    }
  }
  return (
    <>
      {resources.length ? (
        <div className="flex flex-col gap-1 px-5 py-4">
          <CheckRow label={removalClause(resources)} checked={remove} disabled={pending} onCheckedChange={setRemove} />
          <div className="flex flex-col gap-0.5 pl-6 text-xs text-muted-foreground" data-archive-resources>
            {resources.map((r) => (
              <div key={r.id} className="flex min-w-0 gap-2">
                <span className="shrink-0">{KIND_LABEL[r.kind]}</span>
                <Tip label={r.identifier}>
                  <span className="min-w-0 truncate font-mono">{r.label}</span>
                </Tip>
              </div>
            ))}
          </div>
          <ErrorLine error={error} />
        </div>
      ) : error ? (
        <div className="px-5 py-4">
          <ErrorLine error={error} />
        </div>
      ) : (
        <div aria-hidden className="h-4" />
      )}
      <DialogFooter onCancel={onCancel} onConfirm={() => void confirm()} confirmLabel="Archive" pending={pending} />
    </>
  )
}
