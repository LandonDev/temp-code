import type { ClientRequest } from '@shared/contract'
import { emptyBatch } from '@shared/contract-batch'
import type { SessionMeta } from '@shared/events'
import type { SessionRegistry } from './sessions'

/** A master thread's batch (contract-batch.ts). Wave 0: the children come
 *  from the sessions carrying `masterId`; the steps are all pending.
 *  wave 1: "The gate out of the children" fills the steps in. */

/** The unarchived root threads of a master, oldest first. */
export function batchChildren(registry: Pick<SessionRegistry, 'list'>, masterId: string): SessionMeta[] {
  return registry
    .list({ archived: false })
    .filter((s) => s.masterId === masterId && !s.parentId)
    .sort((a, b) => a.createdAt - b.createdAt)
}

export function handleBatch(
  req: ClientRequest,
  registry: Pick<SessionRegistry, 'list'>
): { handled: true; result: unknown } | { handled: false } {
  switch (req.method) {
    case 'batch.get':
      return {
        handled: true,
        result: emptyBatch(req.params.masterId, batchChildren(registry, req.params.masterId).map((s) => s.id))
      }
    case 'batch.children':
      return { handled: true, result: { children: batchChildren(registry, req.params.masterId) } }
    default:
      return { handled: false }
  }
}
