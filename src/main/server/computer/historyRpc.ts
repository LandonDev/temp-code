import type { ClientRequest } from '@shared/contract'
import type { ComputerHistoryPush, ComputerHistoryReadAnswer, ComputerHistoryStepAnswer } from '@shared/contract-computer'
import type { ComputerHistory } from './history'

/**
 * The thread's computer history on the app's own wire
 * (src/shared/contract-computer.ts): `computer.history.read` and
 * `computer.history.step`, both `local`, since the pictures are the
 * person's windows and the reads say what was on them. A socket that read a
 * key hears `computer-history` for it until it closes: a call that changed,
 * or the whole history gone. Nothing here reaches a remote key, the phone,
 * the relay or the MCP facade.
 */

export interface HistoryViewer {
  /** the socket, by identity */
  connection: object
  send: (push: ComputerHistoryPush) => void
}

export class ComputerHistoryRpc {
  /** each socket's keys, and how to reach it */
  private readonly viewers = new Map<object, { send: HistoryViewer['send']; keys: Set<string> }>()
  private readonly off: () => void

  constructor(private readonly history: ComputerHistory) {
    this.off = history.onChange((change) => {
      const push: ComputerHistoryPush = { push: 'computer-history', ...change }
      for (const viewer of this.viewers.values()) if (viewer.keys.has(change.key)) viewer.send(push)
    })
  }

  /** The keys are heard before they are read, so a record that lands meanwhile is pushed, never lost. */
  async read(viewer: HistoryViewer, p: { keys: string[]; before?: number }): Promise<ComputerHistoryReadAnswer> {
    let entry = this.viewers.get(viewer.connection)
    if (!entry) this.viewers.set(viewer.connection, (entry = { send: viewer.send, keys: new Set() }))
    entry.send = viewer.send
    for (const key of p.keys) entry.keys.add(key)
    return { sessions: await this.history.read(p.keys, p.before) }
  }

  step(p: { key: string; n: number }): Promise<ComputerHistoryStepAnswer> {
    return this.history.step(p.key, p.n)
  }

  /** The socket closed: it hears nothing more. */
  dropConnection(connection: object): void {
    this.viewers.delete(connection)
  }

  close(): void {
    this.off()
    this.viewers.clear()
  }
}

export async function handleComputerHistory(req: ClientRequest, rpc: ComputerHistoryRpc | null, viewer: HistoryViewer): Promise<{ handled: boolean; result?: unknown }> {
  if (req.method !== 'computer.history.read' && req.method !== 'computer.history.step') return { handled: false }
  if (!rpc) throw new Error('Computer use is not available here')
  return { handled: true, result: req.method === 'computer.history.read' ? await rpc.read(viewer, req.params) : await rpc.step(req.params) }
}
