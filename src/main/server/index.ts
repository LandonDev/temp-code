import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { CATALOG } from '@shared/catalog'
import { ClientRequestSchema, type ServerFrame } from '@shared/contract'
import type { SessionMeta } from '@shared/events'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { runDoctor } from './drivers/binaries'
import {
  orchAnswerAgent,
  orchCheckAgent,
  orchInterruptAgent,
  orchListAgents,
  orchSendToAgent,
  orchSpawnAgent,
  orchWaitForAgent,
  setOrchestrationRegistry
} from './orchestration'
import {
  appListThreads,
  appReadThread,
  appStartThread,
  setAppBridge,
  setAppToolsRegistry
} from './apptools'
import { DEFAULT_RULES } from '@shared/rules'
import { DEFAULT_THREAD_DEFAULTS } from '@shared/defaults'
import {
  aheadCount,
  branches,
  commit,
  fileDiff,
  listFiles,
  log,
  push,
  showHead,
  workingTreeChanges
} from './git'
import { listCommands } from './commands'
import { readAttachment, saveAttachment } from './attachments'
import {
  closeAllWatchers,
  fsCreate,
  fsDelete,
  fsList,
  fsRead,
  fsRename,
  fsWrite,
  subscribeFileEvents
} from './files'
import { attachLspSocket, ensureLsp, javaDoctor, lspStatus, stopAllLsp } from './lsp'
import { fimComplete } from './fim'

/** The session an app.* call claims to be from — must actually exist. */
function callerOf(registry: SessionRegistry, sessionId: string): SessionMeta {
  const caller = registry.list().find((s) => s.id === sessionId)
  if (!caller) throw new Error(`unknown session: ${sessionId}`)
  return caller
}

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
  registry.resetStaleStatuses()
  registry.startIdleSweep()
  setOrchestrationRegistry(registry)
  setAppToolsRegistry(registry)
  void runDoctor() // warm the cache so the new-session modal opens ready

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })

  wss.on('connection', (ws: WebSocket, req) => {
    // LSP tunnel (docs/PLAN-3.md M13): raw JSON-RPC, no contract schema in
    // the hot path. Same localhost-only single-user trust as everything
    // else; the serverId is validated against the pool.
    const url = req.url ?? ''
    if (url.startsWith('/lsp/')) {
      attachLspSocket(url.slice('/lsp/'.length), ws)
      return
    }
    const unsubs = new Map<string, () => void>()
    /** per-connection file watchers (fs.watch), keyed by projectId */
    const fsWatches = new Map<string, () => void>()
    const sendFrame = (frame: ServerFrame): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
    }
    /** Project lookup that throws — fs/git methods are meaningless without one. */
    const mustProject = (projectId: string): { id: string; cwd: string } => {
      const project = registry.getProject(projectId)
      if (!project) throw new Error(`unknown project: ${projectId}`)
      return project
    }

    // Every client gets session-meta updates (cheap, drives the sidebar).
    const offMeta = registry.onMeta((session) => sendFrame({ push: 'session', session }))
    const offQueue = registry.onQueue((sessionId, items) =>
      sendFrame({ push: 'queue', sessionId, items })
    )
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
            sendFrame({
              id: req.id,
              ok: true,
              result: { ...(await runDoctor()), java: await javaDoctor() }
            })
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
                req.params.mode,
                { baseRef: req.params.baseRef, existingBranch: req.params.existingBranch }
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
          case 'fs.list':
            sendFrame({
              id: req.id,
              ok: true,
              result: fsList(mustProject(req.params.projectId).cwd, req.params.dir)
            })
            break
          case 'fs.read':
            sendFrame({
              id: req.id,
              ok: true,
              result: fsRead(mustProject(req.params.projectId).cwd, req.params.path)
            })
            break
          case 'fs.write':
            sendFrame({
              id: req.id,
              ok: true,
              result: fsWrite(
                mustProject(req.params.projectId).cwd,
                req.params.path,
                req.params.content
              )
            })
            break
          case 'fs.create':
            fsCreate(mustProject(req.params.projectId).cwd, req.params.path, req.params.kind)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'fs.rename':
            fsRename(mustProject(req.params.projectId).cwd, req.params.path, req.params.to)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'fs.delete':
            fsDelete(mustProject(req.params.projectId).cwd, req.params.path)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'fs.watch': {
            const { projectId, subscribe } = req.params
            if (subscribe && !fsWatches.has(projectId)) {
              const project = mustProject(projectId)
              fsWatches.set(
                projectId,
                subscribeFileEvents(projectId, project.cwd, (e) =>
                  sendFrame({ push: 'file-event', ...e })
                )
              )
            } else if (!subscribe) {
              fsWatches.get(projectId)?.()
              fsWatches.delete(projectId)
            }
            sendFrame({ id: req.id, ok: true, result: null })
            break
          }
          case 'project.commit': {
            const project = mustProject(req.params.projectId)
            sendFrame({
              id: req.id,
              ok: true,
              result: await commit(project.cwd, req.params.message, req.params.paths)
            })
            break
          }
          case 'project.push': {
            const project = mustProject(req.params.projectId)
            sendFrame({
              id: req.id,
              ok: true,
              result: await push(project.cwd, req.params.targetBranch)
            })
            break
          }
          case 'project.log': {
            const project = mustProject(req.params.projectId)
            sendFrame({
              id: req.id,
              ok: true,
              result: {
                commits: await log(project.cwd, req.params.limit),
                ahead: await aheadCount(project.cwd)
              }
            })
            break
          }
          case 'project.branches': {
            const ws2 = registry.listWorkspaces().find((w) => w.id === req.params.workspaceId)
            if (!ws2) throw new Error(`unknown workspace: ${req.params.workspaceId}`)
            sendFrame({ id: req.id, ok: true, result: await branches(ws2.path) })
            break
          }
          case 'project.show': {
            const project = mustProject(req.params.projectId)
            sendFrame({
              id: req.id,
              ok: true,
              result: await showHead(project.cwd, req.params.path)
            })
            break
          }
          case 'lsp.ensure': {
            const project = mustProject(req.params.projectId)
            sendFrame({
              id: req.id,
              ok: true,
              result: await ensureLsp(req.params.projectId, project.cwd, req.params.lang)
            })
            break
          }
          case 'lsp.status':
            sendFrame({ id: req.id, ok: true, result: await lspStatus() })
            break
          case 'fim.complete': {
            const project = mustProject(req.params.projectId)
            sendFrame({
              id: req.id,
              ok: true,
              result: await fimComplete(
                project.cwd,
                req.params.path,
                req.params.prefix,
                req.params.suffix
              )
            })
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
          case 'defaults.get': {
            const scoped = registry.getThreadDefaults(req.params.workspaceId)
            sendFrame({
              id: req.id,
              ok: true,
              result: {
                defaults:
                  scoped ??
                  (req.params.workspaceId ? registry.getThreadDefaults(null) : null) ??
                  DEFAULT_THREAD_DEFAULTS,
                overridden: scoped !== null
              }
            })
            break
          }
          case 'defaults.set':
            registry.setThreadDefaults(req.params.workspaceId, req.params.defaults)
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
          case 'queue.list':
            sendFrame({ id: req.id, ok: true, result: registry.queueList(req.params.sessionId) })
            break
          case 'queue.add':
            registry.queueAdd(req.params.sessionId, req.params.text, {
              provider: req.params.provider,
              model: req.params.model,
              reasoning: req.params.reasoning,
              attachments: req.params.attachments
            })
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'queue.remove':
            registry.queueRemove(req.params.sessionId, req.params.messageId)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'queue.update':
            registry.queueUpdate(req.params.sessionId, req.params.messageId, req.params.text)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'queue.reorder':
            registry.queueReorder(req.params.sessionId, req.params.order)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'queue.steer':
            await registry.queueSteer(req.params.sessionId, req.params.messageId)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.answer':
            await registry.answer(req.params.sessionId, req.params.requestId, req.params.answers)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.tune':
            await registry.tune(req.params.sessionId, {
              fast: req.params.fast,
              context1m: req.params.context1m
            })
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.context':
            sendFrame({
              id: req.id,
              ok: true,
              result: await registry.contextUsage(req.params.sessionId)
            })
            break
          case 'session.permission':
            await registry.setPermission(req.params.sessionId, req.params.permission)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          // App tools over WS (M10): the codex bridge's path to the same
          // registry operations the in-process claude toolset uses.
          case 'app.listThreads': {
            const caller = registry.list().find((s) => s.id === req.params.sessionId)
            if (!caller) throw new Error(`unknown session: ${req.params.sessionId}`)
            sendFrame({
              id: req.id,
              ok: true,
              result: appListThreads(registry, caller, req.params.allProjects)
            })
            break
          }
          case 'app.readThread': {
            const caller = registry.list().find((s) => s.id === req.params.sessionId)
            if (!caller) throw new Error(`unknown session: ${req.params.sessionId}`)
            sendFrame({
              id: req.id,
              ok: true,
              result: appReadThread(registry, req.params.threadId)
            })
            break
          }
          case 'app.startThread': {
            const caller = registry.list().find((s) => s.id === req.params.sessionId)
            if (!caller) throw new Error(`unknown session: ${req.params.sessionId}`)
            sendFrame({
              id: req.id,
              ok: true,
              result: await appStartThread(registry, caller, req.params)
            })
            break
          }
          // Orchestration over WS (the codex bridge's spawn path) — every
          // op takes the caller session and guards agentIds to its children.
          case 'app.spawnAgent':
            sendFrame({
              id: req.id,
              ok: true,
              result: await orchSpawnAgent(callerOf(registry, req.params.sessionId), req.params)
            })
            break
          case 'app.sendToAgent':
            sendFrame({
              id: req.id,
              ok: true,
              result: await orchSendToAgent(
                callerOf(registry, req.params.sessionId),
                req.params.agentId,
                req.params.message
              )
            })
            break
          case 'app.checkAgent':
            sendFrame({
              id: req.id,
              ok: true,
              result: orchCheckAgent(callerOf(registry, req.params.sessionId), req.params.agentId)
            })
            break
          case 'app.waitForAgent':
            sendFrame({
              id: req.id,
              ok: true,
              result: await orchWaitForAgent(callerOf(registry, req.params.sessionId), req.params)
            })
            break
          case 'app.answerAgent':
            sendFrame({
              id: req.id,
              ok: true,
              result: await orchAnswerAgent(callerOf(registry, req.params.sessionId), req.params)
            })
            break
          case 'app.interruptAgent':
            sendFrame({
              id: req.id,
              ok: true,
              result: await orchInterruptAgent(
                callerOf(registry, req.params.sessionId),
                req.params.agentId
              )
            })
            break
          case 'app.listAgents':
            sendFrame({
              id: req.id,
              ok: true,
              result: orchListAgents(callerOf(registry, req.params.sessionId))
            })
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
      offQueue()
      offRemoved()
      for (const off of unsubs.values()) off()
      unsubs.clear()
      for (const off of fsWatches.values()) off()
      fsWatches.clear()
    })
  })

  await new Promise<void>((resolve) => wss.on('listening', resolve))
  const address = wss.address()
  const port = typeof address === 'object' && address ? address.port : 0

  // Codex reaches the app tools through the stdio bridge (M10). Dev and
  // scripts run from the repo root; a missing script just disables it.
  const bridgeScript = resolve(process.cwd(), 'scripts', 'app-mcp-bridge.mjs')
  setAppBridge(existsSync(bridgeScript) ? { port, scriptPath: bridgeScript } : null)

  return {
    port,
    registry,
    close: async () => {
      await registry.disposeAll()
      await closeAllWatchers()
      stopAllLsp()
      wss.close()
    }
  }
}
