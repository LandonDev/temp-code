import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import type { ThreadResource } from '@server/shared/contract-resources'
import { Button } from '@renderer/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@renderer/components/ui/empty'
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from '@renderer/components/ui/item'
import { Spinner } from '@renderer/components/ui/spinner'
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
import { useLiveDevServers } from '../lib/devServers'
import { DevServerRow } from './DevServerRow'
import { macBridgeStore } from '../lib/macBridge'
import { DialogFooter, ErrorLine, errorText } from './ConfirmDialog'
import { CheckRow } from './DialogField'
import { Tip } from '../components/tip'
import { Modal, useModalClose } from './Modal'

/**
 * Thread resources (docs/box.md "Thread resources"): the thread menu's
 * "Resources…" panel, one row per worktree, simulator or dev instance the
 * thread created, with where it lives and Remove; and the archive confirm
 * that offers to remove them with the thread. Both read the same store
 * (lib/threadResources.ts), so a removal's outcome lands on the row as the
 * host reports it. Its dev servers are the Dev servers pane's rows for this
 * thread (lib/devServers.ts `liveServers`, chrome/DevServerRow.tsx): the
 * same list from the same source, and nothing a host no longer lists.
 */

const DESTRUCTIVE_GHOST = 'text-destructive hover:bg-destructive/10 hover:text-destructive'

function ResourceRow({ row, onRemove, pending }: { row: ThreadResource; onRemove: () => void; pending: boolean }) {
  const localId = useStore(macBridgeStore, (s) => s.localId)
  // A dev server's line is where it opens here; the ledger's note only when it has one.
  const state = rowState(row) ?? portLine(row, localId)
  const open = rowOpen(row, localId)
  const waiting = !!row.removeRequestedAt && !row.removedAt
  const busy = pending || waiting
  return (
    <Item size="sm" role="listitem" className="px-0" data-resource={row.id}>
      <ItemContent className="min-w-0">
        <Tip label={row.identifier}>
          <ItemTitle className="max-w-full font-mono text-xs">
            <span className="truncate">{row.label}</span>
          </ItemTitle>
        </Tip>
        <div data-slot="item-description" className="flex min-w-0 flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span>{hostName(row.environmentId)}</span>
          <span>{KIND_LABEL[row.kind]}</span>
          {state ? <span className="min-w-0">{state}</span> : null}
        </div>
      </ItemContent>
      <ItemActions>
        {open ? (
          <Tip label={open.url}>
            <Button variant="ghost" size="xs" onClick={() => openUrl(open.url)}>
              {open.label}
            </Button>
          </Tip>
        ) : null}
        <Button variant="ghost" size="xs" disabled={busy} onClick={onRemove} className={DESTRUCTIVE_GHOST}>
          {busy ? <Spinner className="size-3" /> : null}
          {waiting ? 'Waiting' : row.kind === 'port' ? 'Stop' : 'Remove'}
        </Button>
      </ItemActions>
    </Item>
  )
}

/** The rows of one thread with Remove per row and Remove all, its live dev
 *  servers above them; `empty` shows "Nothing recorded" when there are none. */
export function ThreadResourceList({ sessionId, empty }: { sessionId: string; empty?: boolean }) {
  const rows = useThreadResources(sessionId).filter((r) => r.kind !== 'port')
  const servers = useLiveDevServers().filter((s) => s.sessionId === sessionId)
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
  if (rows.length === 0 && servers.length === 0)
    return empty ? (
      <Empty className="p-4">
        <EmptyHeader>
          <EmptyTitle>Nothing recorded</EmptyTitle>
          <EmptyDescription>Worktrees, simulators and dev servers this thread creates show here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    ) : null
  return (
    <div className="flex flex-col gap-2" data-thread-resources={sessionId}>
      {servers.length ? (
        <ItemGroup aria-label="Dev servers">
          {servers.map((server) => (
            <DevServerRow key={server.key} server={server} />
          ))}
        </ItemGroup>
      ) : null}
      {rows.length ? (
        <ItemGroup>
          {rows.map((row) => (
            <ResourceRow key={row.id} row={row} pending={pending.has(row.id)} onRemove={() => void remove([row.id])} />
          ))}
        </ItemGroup>
      ) : null}
      {rows.length > 1 ? (
        <div className="flex justify-end">
          <Button variant="ghost" size="xs" className={DESTRUCTIVE_GHOST} onClick={() => void remove()}>
            Remove all
          </Button>
        </div>
      ) : null}
      <ErrorLine error={error} />
    </div>
  )
}

/** The thread menu's "Resources…". */
export function ThreadResourcesDialog({ sessionId, title, onClose }: { sessionId: string; title: string; onClose: () => void }) {
  useEffect(() => void loadThreadResources(sessionId), [sessionId])
  return (
    <Modal onClose={onClose} title="Resources" description={title} size="md">
      <div className="px-4 py-4">
        <ThreadResourceList sessionId={sessionId} empty />
      </div>
    </Modal>
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
        <div className="flex flex-col gap-1 px-4 py-4">
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
        <div className="px-4 py-4">
          <ErrorLine error={error} />
        </div>
      ) : (
        <div aria-hidden className="h-4" />
      )}
      <DialogFooter onCancel={onCancel} onConfirm={() => void confirm()} confirmLabel="Archive" pending={pending} />
    </>
  )
}
