import type { ClientRequest } from '@shared/contract'
import type { CheckpointStore } from './checkpoint'

type Outcome = { handled: true; result: unknown } | { handled: false }
const result = (value: unknown): Outcome => ({ handled: true, result: value ?? null })

/** The six `checkpoint.*` WS methods; anything else falls through. */
export async function handleCheckpoint(req: ClientRequest, store: CheckpointStore): Promise<Outcome> {
  switch (req.method) {
    case 'checkpoint.ensure':
      return result(await store.ensure(req.params.sessionId, req.params.cwd))
    case 'checkpoint.capture':
      return result(await store.capture(req.params.sessionId, req.params.cwd, req.params.paths))
    case 'checkpoint.sync':
      return result(await store.sync(req.params.sessionId, req.params.cwd))
    case 'checkpoint.status':
      return result(await store.status(req.params.sessionId, req.params.cwd))
    case 'checkpoint.undo':
      return result(await store.undo(req.params.sessionId, req.params.cwd, req.params.relative))
    case 'checkpoint.keep':
      return result(await store.keep(req.params.sessionId, req.params.cwd, req.params.relative))
    default:
      return { handled: false }
  }
}
