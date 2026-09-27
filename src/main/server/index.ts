import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { handleM3a } from './m3a'
import { Notes } from './notes'
import { ProjectLogos } from './projectLogos'
import { AccountsService } from './accounts'
import { startGateway, type Gateway } from './gateway'
import { observeHooks } from './gatewayObserve'
import { WebSocketServer, type WebSocket } from 'ws'
import { CATALOG } from '@shared/catalog'
import { ClientRequestSchema, type ServerFrame } from '@shared/contract'
import type { SessionMeta } from '@shared/events'
import { openDb, Store } from './db'
import { handleFsGit } from './fsgit'
import { CheckpointStore } from './checkpoint'
import { handleCheckpoint } from './checkpointRpc'
import { Linear, handleLinear } from './linear'
import { SessionRegistry } from './sessions'
import { resolveAppBridgeLaunch, runDoctor, updateProvider } from './drivers/binaries'
import { probeCatalogs } from './drivers/catalogProbe'
import { backfillMirrors } from './mirror'
import { bootMark } from './boot'
import { setLimitMissLog } from './limitText'
import { setCodexBootFailureLog } from './drivers/codex'
import { sweepFolds } from './folds'
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
  blameRange,
  aheadCount,
  branches,
  commit,
  compare,
  fileDiff,
  listFiles,
  log,
  mergeFrom,
  mergeInto,
  push,
  showRef,
  workingTreeChanges
} from './git'
import { listCommands } from './commands'
import { workspaceIcon } from './wsicon'
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
import { attachDapSocket, connectDap, stopAllDap } from './dap'
import {
  attachLspSocket,
  ensureLsp,
  ideaAcceptEula,
  ideaCheckUpdate,
  ideaEula,
  javaDoctor,
  lspStatus,
  stopAllLsp,
  sweepIdeaWarmState,
  warmIdeaIndexes
} from './lsp'
import { killTrackedChildren } from './spawnBudget'
import { fimComplete } from './fim'
import {
  BuildRunner,
  buildTargets,
  detectBuild,
  pullBranch,
  remoteStatus,
  resolveBuildDir
} from './build'
import { closeAllLiveWatchers, onLiveEdit } from './livediff'

/** The session an app.* call claims to be from — must actually exist. */
function callerOf(registry: SessionRegistry, sessionId: string): SessionMeta {
  const caller = registry.get(sessionId)
  if (!caller) throw new Error(`unknown session: ${sessionId}`)
  return caller
}

/** file.read is fenced to project working trees (plan docs live there). */
function readAllowedFile(registry: SessionRegistry, path: string): string | null {
  // Containment allows either spelling of a root — /tmp vs /private/tmp
  // (or any symlinked workspace root) must not fail the check, and a file
  // that doesn't exist yet (plan polls) must still resolve.
  const real = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  const abs = resolve(path)
  const absReal = real(abs)
  const allowed = registry
    .listProjects()
    .flatMap((p) => [resolve(p.cwd), real(resolve(p.cwd))])
    .some((root) => abs.startsWith(root) || absReal.startsWith(root))
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
  store: Store
  gateway: Gateway
  close: () => Promise<void>
}

let firstListMarked = false
/** WS requests slower than this land in the boot log. */
const SLOW_REQUEST_MS = 500

export async function startServer(
  dbPath: string,
  options: { dataDir?: string; appPath?: string; claimShim?: boolean } = {}
): Promise<RunningServer> {
  bootMark('server-start')
  const db = openDb(dbPath)
  bootMark('db-open')
  const store = new Store(db)
  const checkpoints = new CheckpointStore(join(options.dataDir ?? dirname(dbPath), 'checkpoints'))
  const registry = new SessionRegistry(store)
  setLimitMissLog(join(options.dataDir ?? dirname(dbPath), 'logs'))
  setCodexBootFailureLog(join(options.dataDir ?? dirname(dbPath), 'logs'))
  registry.checkpoints = checkpoints
  const accounts = new AccountsService()
  registry.limits = accounts
  const m3a = { store, registry, notes: new Notes(db), logos: new ProjectLogos(options.dataDir ?? dirname(dbPath)), accounts }
  // Every snapshot that knows any account re-picks the open threads'
  // accounts (an empty one would pick nothing): the first covers boot.
  accounts.onChange((snapshot) => {
    if (Object.values(snapshot.providers).some((p) => p.profiles.length > 0)) registry.refreshAccounts()
  })
  accounts.start()
  const gateway = await startGateway({
    claimShim: options.claimShim ?? false,
    hooks: {
      ...observeHooks({ logDir: join(options.dataDir ?? dirname(dbPath), 'logs'), onObserved: () => accounts.nudge() }),
      pickNext: (info) => accounts.pickNext(info),
      // Unscoped (terminal) traffic moved the global pin: the footer follows.
      onFailedOver: (info) => {
        console.log(`[gateway] ${info.service}: ${info.from} hit a limit, the pin moved to ${info.to}`)
        accounts.nudge()
      },
      // One thread moved (or came back to its pin): only its row follows.
      onRouted: (info) => {
        console.log(`[gateway] ${info.service} ${info.thread}: now on ${info.account}`)
        registry.setAccount(info.thread, info.account)
      }
    }
  })
  const linear = new Linear(options.dataDir ?? dirname(dbPath))
  registry.resetStaleStatuses()
  registry.startIdleSweep()
  // Fold catch-up: sessions whose sidebar folds are missing or behind
  // their log (first boot after upgrade, a crash, an older build) heal in
  // the background, newest first, without blocking the first list.
  // The mirror catch-up follows it so two heavy log readers never
  // interleave.
  const foldTimer = setTimeout(() => {
    bootMark('fold-backfill start')
    sweepFolds(store, registry, {
      onProgress: (n, total) => {
        if (n % 200 === 0) bootMark('fold-backfill progress', `${n}/${total}`)
      }
    })
      .then((n) => bootMark('fold-backfill done', `${n} sessions`))
      .catch((err) => console.error('[folds] sweep failed', err))
      .then(() => backfillMirrors(registry))
      .catch((err) => console.error('[mirror] backfill failed', err))
  }, 2_000)
  foldTimer.unref()
  setOrchestrationRegistry(registry)
  setAppToolsRegistry(registry)
  void runDoctor() // warm the cache so the new-session modal opens ready
  void probeCatalogs() // the five probed harnesses ask their CLIs for models

  // Background IntelliJ index warming: shortly after startup, then every
  // 10 minutes (catches HEAD moves from commits/branch switches). Both
  // are no-ops for projects that are current.
  const warmAll = (): void => {
    const projects = registry.listProjects().map((p) => ({ id: p.id, cwd: p.cwd }))
    sweepIdeaWarmState(projects.map((p) => p.id))
    void warmIdeaIndexes(projects)
  }
  const warmKickoff = setTimeout(warmAll, 15_000)
  warmKickoff.unref()
  const warmTimer = setInterval(warmAll, 10 * 60_000)
  warmTimer.unref()

  const builder = new BuildRunner()

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
    if (url.startsWith('/dap/')) {
      attachDapSocket(url.slice('/dap/'.length), ws)
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
    const offCatalog = registry.onCatalog((kind) => sendFrame(kind === 'workspaces'
      ? { push: 'workspaces', workspaces: registry.listWorkspaces() }
      : { push: 'projects', projects: registry.listProjects() }))
    const offLive = onLiveEdit((p) => sendFrame(p))
    const offBuild = builder.onPush((p) => sendFrame(p))
    const offAccounts = m3a.accounts.onChange((snapshot) => sendFrame({ push: 'accounts', snapshot }))
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
      const startedAt = Date.now()
      try {
        const extension = await handleM3a(req, m3a)
        if (extension.handled) { sendFrame({ id: req.id, ok: true, result: extension.result }); return }
        const fsGit = await handleFsGit(req)
        if (fsGit.handled) return sendFrame({ id: req.id, ok: true, result: fsGit.result })
        const checkpoint = await handleCheckpoint(req, checkpoints)
        if (checkpoint.handled) return sendFrame({ id: req.id, ok: true, result: checkpoint.result })
        const lin = await handleLinear(req, linear)
        if (lin.handled) return sendFrame({ id: req.id, ok: true, result: lin.result })
        switch (req.method) {
          case 'catalog.get':
            if (req.params?.refresh) await probeCatalogs(true)
            sendFrame({ id: req.id, ok: true, result: CATALOG })
            break
          case 'doctor.get':
            sendFrame({
              id: req.id,
              ok: true,
              result: { ...(await runDoctor()), java: await javaDoctor() }
            })
            break
          case 'providers.update':
            sendFrame({
              id: req.id,
              ok: true,
              result: await updateProvider(req.params.provider)
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
          case 'workspace.icon': {
            const ws = registry.listWorkspaces().find((w) => w.id === req.params.workspaceId)
            sendFrame({
              id: req.id,
              ok: true,
              result: ws ? await workspaceIcon(ws.path) : { dataUrl: null, host: null }
            })
            break
          }
          case 'project.create': {
            const created = await registry.createProject(
              req.params.workspaceId,
              req.params.name,
              req.params.mode,
              { branch: req.params.branch, baseRef: req.params.baseRef }
            )
            sendFrame({ id: req.id, ok: true, result: created })
            void warmIdeaIndexes([{ id: created.id, cwd: created.cwd }])
            break
          }
          case 'project.list':
            sendFrame({ id: req.id, ok: true, result: registry.listProjects() })
            break
          case 'project.rename':
            registry.renameProject(req.params.projectId, req.params.name)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'project.setAccounts':
            registry.setProjectAccounts(req.params.projectId, req.params.pins)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'workspace.setAccounts':
            registry.setWorkspaceAccounts(req.params.workspaceId, req.params.pins)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'project.setBranch':
            await registry.setProjectBranch(
              req.params.projectId,
              req.params.branch,
              req.params.baseRef
            )
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'project.archive':
            await registry.archiveProject(
              req.params.projectId,
              req.params.archived,
              req.params.cleanup
            )
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'project.delete':
            await registry.deleteProject(req.params.projectId, req.params.cleanup)
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
              result: await showRef(project.cwd, req.params.path, req.params.ref)
            })
            break
          }
          case 'project.compare': {
            const project = mustProject(req.params.projectId)
            sendFrame({
              id: req.id,
              ok: true,
              result: await compare(project.cwd, req.params.target)
            })
            break
          }
          case 'project.mergeFrom': {
            const project = mustProject(req.params.projectId)
            sendFrame({
              id: req.id,
              ok: true,
              result: await mergeFrom(project.cwd, req.params.target, req.params.mode)
            })
            break
          }
          case 'project.mergeInto': {
            const project = mustProject(req.params.projectId)
            sendFrame({
              id: req.id,
              ok: true,
              result: await mergeInto(project.cwd, req.params.target)
            })
            break
          }
          case 'project.blame': {
            const project = mustProject(req.params.projectId)
            sendFrame({
              id: req.id,
              ok: true,
              result: await blameRange(
                project.cwd,
                req.params.path,
                req.params.startLine,
                req.params.endLine
              )
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
          case 'idea.eula':
            sendFrame({ id: req.id, ok: true, result: await ideaEula() })
            break
          case 'idea.acceptEula':
            sendFrame({ id: req.id, ok: true, result: ideaAcceptEula() })
            warmAll() // acceptance unblocks the whole warm queue
            break
          case 'idea.checkUpdate':
            sendFrame({ id: req.id, ok: true, result: await ideaCheckUpdate() })
            break
          case 'dap.connect':
            sendFrame({ id: req.id, ok: true, result: await connectDap(req.params.port) })
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
          case 'turnpass.get':
            sendFrame({
              id: req.id,
              ok: true,
              result: req.params.projectId
                ? registry.getProjectTurnPass(req.params.projectId)
                : registry.getTurnPass(req.params.workspaceId)
            })
            break
          case 'turnpass.set':
            if (req.params.projectId)
              registry.setProjectTurnPass(req.params.projectId, req.params.pass)
            else registry.setTurnPass(req.params.workspaceId, req.params.pass)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'build.get':
            sendFrame({
              id: req.id,
              ok: true,
              result: req.params.projectId
                ? registry.getProjectBuild(req.params.projectId)
                : registry.getBuild(req.params.workspaceId)
            })
            break
          case 'build.set':
            if (req.params.projectId) registry.setProjectBuild(req.params.projectId, req.params.config)
            else registry.setBuild(req.params.workspaceId, req.params.config)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'build.effective': {
            const project = registry.getProject(req.params.projectId)
            if (!project) throw new Error(`unknown project: ${req.params.projectId}`)
            // Detection for another branch looks at a checkout that holds it;
            // an unheld branch is only materialized when a build runs.
            const holder = req.params.branch
              ? (await buildTargets(project)).find((t) => t.branch === req.params.branch)?.cwd
              : null
            sendFrame({
              id: req.id,
              ok: true,
              result: await registry.effectiveBuild(project.id, holder ?? undefined)
            })
            break
          }
          case 'build.targets': {
            const project = registry.getProject(req.params.projectId)
            if (!project) throw new Error(`unknown project: ${req.params.projectId}`)
            sendFrame({ id: req.id, ok: true, result: await buildTargets(project) })
            break
          }
          case 'build.remote': {
            const project = registry.getProject(req.params.projectId)
            if (!project) throw new Error(`unknown project: ${req.params.projectId}`)
            sendFrame({ id: req.id, ok: true, result: await remoteStatus(project, req.params.branch) })
            break
          }
          case 'build.pull': {
            const project = registry.getProject(req.params.projectId)
            if (!project) throw new Error(`unknown project: ${req.params.projectId}`)
            const branch = req.params.branch ?? project.branch ?? ''
            sendFrame({
              id: req.id,
              ok: true,
              result: await pullBranch(project, req.params.branch, (p) =>
                sendFrame({ push: 'sync', projectId: project.id, branch, ...p })
              )
            })
            break
          }
          case 'build.detect':
            sendFrame({ id: req.id, ok: true, result: await detectBuild(req.params.path) })
            break
          case 'build.run': {
            const project = registry.getProject(req.params.projectId)
            if (!project) throw new Error(`unknown project: ${req.params.projectId}`)
            if (builder.isRunning(project.id)) throw new Error('a build is already running')
            const where = await resolveBuildDir(project, req.params.branch)
            const build = await registry.effectiveBuild(project.id, where.cwd)
            if (!build) throw new Error('no build command configured')
            sendFrame({
              id: req.id,
              ok: true,
              result: await builder.run(project.id, where.cwd, build, where.branch)
            })
            break
          }
          case 'build.cancel':
            builder.cancel(req.params.projectId)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'build.status':
            sendFrame({ id: req.id, ok: true, result: builder.status(req.params.projectId) })
            break
          case 'appshots.get':
            sendFrame({ id: req.id, ok: true, result: registry.getAppshotSettings() })
            break
          case 'appshots.set':
            registry.setAppshotSettings(req.params.settings)
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
          case 'session.list': {
            const sessions = registry.list()
            if (!firstListMarked) {
              firstListMarked = true
              bootMark('first-session-list', `${sessions.length} sessions`)
            }
            sendFrame({ id: req.id, ok: true, result: sessions })
            break
          }
          case 'session.events':
            sendFrame({
              id: req.id,
              ok: true,
              result: registry.events(req.params.sessionId, req.params)
            })
            break
          case 'session.send':
            await registry.send(req.params.sessionId, req.params.text, {
              provider: req.params.provider,
              model: req.params.model,
              reasoning: req.params.reasoning,
              attachments: req.params.attachments,
              newPass: req.params.newPass
            })
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.interrupt':
            await registry.stopRun(req.params.sessionId)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.pause':
            await registry.pauseRun(req.params.sessionId)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.resume':
            await registry.resumePausedRun(req.params.sessionId)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.continueAllErrors':
            sendFrame({ id: req.id, ok: true, result: await registry.continueAllErrors() })
            break
          case 'session.pauseAllRunning':
            sendFrame({ id: req.id, ok: true, result: await registry.pauseAllRunning() })
            break
          case 'session.resumeAllPaused':
            sendFrame({ id: req.id, ok: true, result: await registry.resumeAllPaused() })
            break
          case 'session.subscribe': {
            const { sessionId } = req.params
            // Opening a thread: its shown account is the one its next send uses.
            registry.refreshAccount(sessionId)
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
          case 'session.setThreadRules':
            await registry.setThreadRules(req.params.sessionId, req.params.threadRules)
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
          case 'session.continue':
            await registry.continueRun(req.params.sessionId)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.approve':
            await registry.approve(req.params.sessionId, req.params.requestId, req.params.allow)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.setGoal':
            await registry.setGoal(req.params.sessionId, req.params.condition)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.clearGoal':
            await registry.clearGoal(req.params.sessionId)
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
            registry.queueUpdate(req.params.sessionId, req.params.messageId, {
              text: req.params.text,
              provider: req.params.provider,
              model: req.params.model,
              reasoning: req.params.reasoning
            })
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
              context1m: req.params.context1m,
              model: req.params.model
            })
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.retype':
            await registry.retype(req.params.sessionId, req.params.threadType)
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
            const caller = registry.get(req.params.sessionId)
            if (!caller) throw new Error(`unknown session: ${req.params.sessionId}`)
            sendFrame({
              id: req.id,
              ok: true,
              result: appListThreads(registry, caller, req.params.allProjects)
            })
            break
          }
          case 'app.readThread': {
            const caller = registry.get(req.params.sessionId)
            if (!caller) throw new Error(`unknown session: ${req.params.sessionId}`)
            sendFrame({
              id: req.id,
              ok: true,
              result: appReadThread(registry, req.params.threadId)
            })
            break
          }
          case 'app.startThread': {
            const caller = registry.get(req.params.sessionId)
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
      } finally {
        // A request this slow held the main thread or waited behind
        // something that did; either way the boot log should say which.
        const ms = Date.now() - startedAt
        if (ms > SLOW_REQUEST_MS) bootMark('slow-request', `${req.method} ${ms}ms`)
      }
    })

    ws.on('close', () => {
      offMeta()
      offCatalog()
      offQueue()
      offLive()
      offBuild()
      offAccounts()
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

  // Codex reaches the app tools through the stdio bridge (M10). The app's
  // own location covers dev (repo root) and packaged
  // (Contents/Resources/app); the cwd fallback is for the standalone
  // scripts/e2e-*.ts runs, which have no app path to pass in.
  const bridgeScript = resolve(options.appPath ?? process.cwd(), 'scripts', 'app-mcp-bridge.mjs')
  if (existsSync(bridgeScript)) {
    const launch = await resolveAppBridgeLaunch()
    setAppBridge({ port, scriptPath: bridgeScript, command: launch.command, env: launch.env })
    if (launch.note) console.error(`[app-bridge] ${launch.note}`)
  } else {
    console.error(
      `[app-bridge] app-mcp-bridge.mjs not found at ${bridgeScript} — app tools are unavailable to Codex threads`
    )
    setAppBridge(null)
  }

  return {
    port,
    registry,
    store,
    gateway,
    close: async () => {
      clearTimeout(warmKickoff)
      clearInterval(warmTimer)
      builder.disposeAll()
      await gateway.stop()
      m3a.accounts.stop()
      await registry.disposeAll()
      await closeAllWatchers()
      await closeAllLiveWatchers()
      stopAllLsp()
      stopAllDap()
      killTrackedChildren()
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve, reject) => wss.close((error) => error ? reject(error) : resolve()))
      db.close()
    }
  }
}
