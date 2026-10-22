import type { ClientRequest } from '@shared/contract'
import type { CheckpointTurns } from './checkpointTurns'

type Outcome = { handled: true; result: unknown } | { handled: false }
const result = (value: unknown): Outcome => ({ handled: true, result: value ?? null })

/** The three `checkpoint.*` WS methods; the host finds the thread's cwd. */
export async function handleCheckpoint(req: ClientRequest, turns: CheckpointTurns): Promise<Outcome> {
  switch (req.method) {
    case 'checkpoint.status':
      return result(await turns.status(req.params.sessionId))
    case 'checkpoint.undo':
      return result(await turns.undo(req.params.sessionId, req.params.relative))
    case 'checkpoint.keep':
      return result(await turns.keep(req.params.sessionId, req.params.relative))
    default:
      return { handled: false }
  }
}
