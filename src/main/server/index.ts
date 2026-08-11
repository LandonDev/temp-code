import { WebSocketServer, type WebSocket } from 'ws'
import { CATALOG } from '@shared/catalog'
import { ClientRequestSchema, type ServerFrame } from '@shared/contract'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { runDoctor } from './drivers/binaries'
import { setOrchestrationRegistry } from './orchestration'

/**
 * The server. Runs inside Electron's main process (T3 runs it as a separate
 * process — that split is a later milestone, which is why the renderer talks
 * WebSocket and not IPC: the transport already assumes the server could be
 * anywhere, including a remote machine for the future mobile client).
 *
 * Localhost-only, dynamic port.
 */

export interface RunningServer {
  port: number
  registry: SessionRegistry
  close: () => Promise<void>
}

export async function startServer(dbPath: string): Promise<RunningServer> {
  const store = new Store(openDb(dbPath))
  const registry = new SessionRegistry(store)
  registry.startIdleSweep()
  setOrchestrationRegistry(registry)
  void runDoctor() // warm the cache so the new-session modal opens ready

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })

  wss.on('connection', (ws: WebSocket) => {
    const unsubs = new Map<string, () => void>()
    const sendFrame = (frame: ServerFrame): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
    }

    // Every client gets session-meta updates (cheap, drives the sidebar).
    const offMeta = registry.onMeta((session) => sendFrame({ push: 'session', session }))
    const offRemoved = registry.onRemoved((sessionIds) => {
      for (const id of sessionIds) {
        unsubs.get(id)?.()
        unsubs.delete(id)
      }
      sendFrame({ push: 'session-removed', sessionIds })
    })

    ws.on('message', async (data) => {
      let raw: unknown
      try {
        raw = JSON.parse(String(data))
      } catch {
        return
      }
      const parsed = ClientRequestSchema.safeParse(raw)
      if (!parsed.success) {
        const id = (raw as { id?: string })?.id
        if (id) sendFrame({ id, ok: false, error: `bad request: ${parsed.error.message}` })
        return
      }
      const req = parsed.data
      try {
        switch (req.method) {
          case 'catalog.get':
            sendFrame({ id: req.id, ok: true, result: CATALOG })
            break
          case 'doctor.get':
            sendFrame({ id: req.id, ok: true, result: await runDoctor() })
            break
          case 'session.create': {
            const session = await registry.create(req.params)
            sendFrame({ id: req.id, ok: true, result: session })
            break
          }
          case 'session.list':
            sendFrame({ id: req.id, ok: true, result: registry.list() })
            break
          case 'session.events':
            sendFrame({
              id: req.id,
              ok: true,
              result: registry.eventsAfter(req.params.sessionId, req.params.afterSeq)
            })
            break
          case 'session.send':
            await registry.send(req.params.sessionId, req.params.text)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.interrupt':
            await registry.interrupt(req.params.sessionId)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.subscribe': {
            const { sessionId } = req.params
            if (!unsubs.has(sessionId)) {
              unsubs.set(
                sessionId,
                registry.subscribe(sessionId, (row) => sendFrame({ push: 'event', row }))
              )
            }
            sendFrame({ id: req.id, ok: true, result: null })
            break
          }
          case 'session.unsubscribe':
            unsubs.get(req.params.sessionId)?.()
            unsubs.delete(req.params.sessionId)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.archive':
            await registry.setArchived(req.params.sessionId, req.params.archived)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.delete':
            await registry.delete(req.params.sessionId)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.restart':
            await registry.restart(req.params.sessionId)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.approve':
            await registry.approve(req.params.sessionId, req.params.requestId, req.params.allow)
            sendFrame({ id: req.id, ok: true, result: null })
            break
        }
      } catch (err) {
        sendFrame({
          id: req.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    })

    ws.on('close', () => {
      offMeta()
      offRemoved()
      for (const off of unsubs.values()) off()
      unsubs.clear()
    })
  })

  await new Promise<void>((resolve) => wss.on('listening', resolve))
  const address = wss.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    port,
    registry,
    close: async () => {
      await registry.disposeAll()
      wss.close()
    }
  }
}
