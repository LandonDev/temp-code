import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { CATALOG } from '@shared/catalog'
import { ClientRequestSchema, type ServerFrame } from '@shared/contract'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { runDoctor } from './drivers/binaries'
import { setOrchestrationRegistry } from './orchestration'
import { DEFAULT_RULES } from '@shared/rules'
import { fileDiff, listFiles, workingTreeChanges } from './git'
import { listCommands } from './commands'
import { readAttachment, saveAttachment } from './attachments'

/** file.read is fenced to project working trees (plan docs live there). */
function readAllowedFile(registry: SessionRegistry, path: string): string | null {
  const abs = resolve(path)
  const allowed = registry.listProjects().some((p) => abs.startsWith(resolve(p.cwd)))
  if (!allowed) throw new Error('path outside app-managed directories')
  try {
    return readFileSync(abs, 'utf8')
  } catch {
    return null // not written yet — the plan view polls until it exists
  }
}

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
          case 'workspace.create':
            sendFrame({
              id: req.id,
              ok: true,
              result: await registry.createWorkspace(req.params.path, req.params.name)
            })
            break
          case 'workspace.list':
            sendFrame({ id: req.id, ok: true, result: registry.listWorkspaces() })
            break
          case 'workspace.delete':
            await registry.deleteWorkspace(req.params.workspaceId)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'project.create':
            sendFrame({
              id: req.id,
              ok: true,
              result: await registry.createProject(
                req.params.workspaceId,
                req.params.name,
                req.params.mode
              )
            })
            break
          case 'project.list':
            sendFrame({ id: req.id, ok: true, result: registry.listProjects() })
            break
          case 'project.delete':
            await registry.deleteProject(req.params.projectId)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'project.changes': {
            const project = registry.getProject(req.params.projectId)
            sendFrame({
              id: req.id,
              ok: true,
              result: project ? await workingTreeChanges(project.cwd) : []
            })
            break
          }
          case 'project.diff': {
            const project = registry.getProject(req.params.projectId)
            sendFrame({
              id: req.id,
              ok: true,
              result: project ? await fileDiff(project.cwd, req.params.path) : ''
            })
            break
          }
          case 'project.files': {
            const project = registry.getProject(req.params.projectId)
            sendFrame({ id: req.id, ok: true, result: project ? await listFiles(project.cwd) : [] })
            break
          }
          case 'file.read': {
            sendFrame({ id: req.id, ok: true, result: readAllowedFile(registry, req.params.path) })
            break
          }
          case 'rules.get': {
            const scoped = registry.getOrchestrationRules(req.params.workspaceId)
            sendFrame({
              id: req.id,
              ok: true,
              // rules: what applies here (override → global → defaults);
              // overridden: whether THIS scope has its own copy.
              result: {
                rules:
                  scoped ??
                  (req.params.workspaceId ? registry.getOrchestrationRules(null) : null) ??
                  DEFAULT_RULES,
                overridden: scoped !== null
              }
            })
            break
          }
          case 'rules.set':
            registry.setOrchestrationRules(req.params.workspaceId, req.params.rules)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'commands.list':
            sendFrame({
              id: req.id,
              ok: true,
              result: await listCommands(req.params.provider, req.params.cwd)
            })
            break
          case 'attachment.save':
            sendFrame({
              id: req.id,
              ok: true,
              result: await saveAttachment(req.params.name, req.params.dataBase64)
            })
            break
          case 'attachment.read':
            sendFrame({
              id: req.id,
              ok: true,
              result: await readAttachment(
                req.params.path,
                registry.listProjects().map((p) => p.cwd)
              )
            })
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
            await registry.send(req.params.sessionId, req.params.text, {
              provider: req.params.provider,
              model: req.params.model,
              reasoning: req.params.reasoning,
              attachments: req.params.attachments
            })
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
          case 'session.rename':
            await registry.rename(req.params.sessionId, req.params.title)
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
          case 'session.answer':
            await registry.answer(req.params.sessionId, req.params.requestId, req.params.answers)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.permission':
            await registry.setPermission(req.params.sessionId, req.params.permission)
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
