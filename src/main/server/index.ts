import { homedir, hostname } from 'node:os'
import { version as appVersion } from '../../../package.json'
import { hubFromEnv, type HubClient } from './hub'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { handleM3a } from './m3a'
import { withinRoots } from './fspaths'
import { Notes } from './notes'
import { ProjectLogos } from './projectLogos'
import { AccountsService, accountsPusher } from './accounts'
import { isRoutedProvider, PROVIDER_OF, SERVICE_OF } from '@shared/accounts'
import { gateway as runningGateway, startGateway, type Gateway, type SpawnGatewayChild } from './gateway'
import { BootResumer } from './resumeAfterBoot'
import { Admission } from './admission'
import { closeWarmPools, retireWarmPools, warmStatuses } from './drivers/warm'
import { observeHooks } from './gatewayObserve'
import { HeadroomStore } from './headroom'
import { WebSocketServer, type WebSocket } from 'ws'
import { createServer } from 'node:http'
import { visibleCatalog } from '@shared/catalog'
import { refusalCodeOf } from './failureKind'
import { ClientRequestSchema, type ClientRequest, type ServerFrame, type ServerPush, type ServerResponse } from '@shared/contract'
import type { SessionChanges } from '@shared/wire'
import {
  CONTRACT_VERSION,
  LOCAL_PRINCIPAL,
  allows,
  principalCaps,
  requiredCapability,
  type Principal
} from '@shared/capabilities'
import { loadEnvironmentId } from './remote/environment'
import { handleRemote, type RemoteContext } from './remote/handlers'
import { buildFacts, hostPlatform } from '../buildInfo'
import type { BuildFacts } from '@shared/deployDrift'
import type { MediaRange } from '@shared/contract-fsgit'
import { MasterReleaseWatcher } from '../deployDrift'
import { AccountSync, accountSyncHooks } from './remote/accountSync'
import { Peers } from './remote/peers'
import { HarnessSync, handleHarness } from './remote/harnessSync'
import { DeployTrigger, Publisher, handleHost, type HostJobs } from './hostJobs'
import { MemorySync, handleMemory } from './remote/memorySync'
import { ProjectLinker } from './remote/projectLinks'
import { ProjectSettingsSync } from './remote/projectSettingsSync'
import { RulesSync } from './remote/rulesSync'
import { SessionMover, handleSessionMove } from './remote/sessionMover'
import { claudeConfigDir, codexHomeDir } from './sessionMove'
import { PeerCalls, handlePeerRequest, type LinkRequest } from './remote/peerCalls'
import { handlePeerPull, macWriteStages } from './macWriteStage'
import { MacBridge, handleMacBridge } from './remote/macBridge'
import { CrossHostThreads, crossHostOffers } from './remote/crossHostThreads'
import { HostLinks } from './remote/hostLinks'
import { CROSS_HOST_OFFER } from '@shared/contract-crosshost'
import { CrossHostAgents } from './crossHostAgents'
import { HostDevicesHub, MacDevices, handleHostDevices, hostDevicesOffers, isMacHost } from './devices/hostDevices'
import { readSimulatorHolders } from './devices/ledger'
import { MergeReviews, mergeReviews, setMergeReviews } from './mergeReview'
import { MacThreadTokens, MacTools, macToolsHooks, rebootWhenSettled } from './macTools'
import { OfflineError, ThreadResources } from './threadResources'
import { SharedScanner, ThreadPorts } from './threadPorts'
import { PortTail } from './portTail'
import { PortSweep } from './portSweep'
import { DevRuns } from './devRuns'
import { PortLogs } from './portLog'
import { PortForwardHost } from './remote/portForward'
import { MacPortForwards, forwardSettingKey } from './remote/macPorts'
import { PORTS_OFFER, type ForwardedPort } from '@shared/contract-ports'
import { runMacCommand } from './remote/macRunner'
import { MAC_APPROVAL_WAIT_MS, MAC_BRIDGE_OFFER, type MacRunResult } from '@shared/contract-macbridge'
import type { MacHeldPush } from '@shared/contract-macbridge'
import { MacRunCalls, MacRunLive } from './macRunLive'
import { macBridgeLandingRoot } from './macBridgeLanding'
import { listEnvironments } from './remote/environments'
import { LIVE_STATUSES } from '@shared/session-lifecycle'
import { isHeadless } from '../headless'
import type { SelfUpdateOutcome } from '../updateTrigger'
import { RemoteAuth } from './remote/auth'
import { startRemoteListener, type RemoteListener } from './remote/listener'
import { fenceRequest } from './remote/fence'
import { createMcpHandler } from './remote/mcp'
import { Notifier } from './remote/notifier'
import { MacPresenceWatcher, type PresenceSource } from '../presence'
import { HostRelay, PeerRelayTransport } from './remote/relay'
import { RelayServer, relayOffers } from './remote/relayServe'
import type { PowerState, ScreenState } from '@shared/contract-relay'
import type { MacPresence } from '@shared/contract-relay'
import { apnsFromEnv } from './remote/apns'
import { ActivityFeed, PushRegistry } from './remote/push'
import { deliverWebhooks, webhookPayload } from './remote/webhooks'
import { createUiHandler } from './remote/ui'
import { pairingOrigin, readRemoteSettings } from './remote/handlers'
import type { SessionMeta } from '@shared/events'
import { openDb, Store } from './db'
import { migrateHousePreamble, seedHousePreamble } from './projectPreamble'
import { EventReader, startCheckpointWorker } from './dbWorkers'
import { handleFsGit } from './fsgit'
import { workRoot } from './workRoot'
import { readMediaRange, setMediaHost, setMediaRoots } from './media'
import { CheckpointStore, inHeadMany, listTracked } from './checkpoint'
import { handleCheckpoint } from './checkpointRpc'
import { CheckpointTurns } from './checkpointTurns'
import { Linear, handleLinear } from './linear'
import { GithubInbox, handleGithubInbox } from './githubInbox'
import { SessionRegistry } from './sessions'
import { readPage } from './htmlRender'
import { harnessEnv, resolveAppBridgeLaunch, runDoctor, updateProvider } from './drivers/binaries'
import { probeCatalogs } from './drivers/catalogProbe'
import { codexTiersReady, probeCodexTiers, startCodexTiers } from './drivers/codexTiers'
import { forgetCodexVersion, installedCodexVersion } from './drivers/codexVersion'
import { backfillMirrors, cappedThreadDigest } from './mirror'
import { bootMark } from './boot'
import { setLimitMissLog } from './limitText'
import { setCodexBootFailureLog } from './drivers/codex'
import {
  BACKPRESSURE_BYTES,
  countPush,
  currentLag,
  inFlightRequests,
  recordBackpressure,
  recordSlowRequest,
  reportRendererStall,
  setBufferedBytes,
  setLaneStats,
  setRunningCount,
  setStallLog,
  startStallMonitor,
  timed,
  trackRequest,
  untrackRequest
} from './stalls'
import { configureHostProfiler, profileHost } from './doctorProfile'
import type { DoctorGetResult } from '@shared/contract'
import { sweepFolds } from './folds'
import { ColdMover, sweepArchive } from './cold'
import {
  orchAnswerAgent,
  orchCheckAgent,
  orchInterruptAgent,
  orchListAgents,
  orchSendToAgent,
  orchSpawnAgent,
  orchWaitForAgent,
  setCrossHostAgents,
  setOrchestrationRegistry
} from './orchestration'
import {
  appHtmlPreview,
  appHtmlRender,
  appListThreads,
  appReadThread,
  appUpdateNotes,
  appStartThread,
  setAppBridge,
  setAppCrossHost,
  setAppToolsRegistry,
  setProjectPlans
} from './apptools'
import { ProjectPlans, handleProjectPlan } from './projectPlan'
import { Batches, batchChildren, handleBatch, setBatches } from './batch'
import { hostBoardDigests } from './boardDigest'
import { BoardWatch } from './boardWatch'
import { LocalPublish, MacPublish, macPublishOffers } from './remote/macPublish'
import { PeerDeploy } from './remote/peerDeploy'
import { PeerPublish } from './remote/peerPublish'
import { ReleaseAnnouncer } from './releaseAnnounce'
import { DEFAULT_RULES } from '@shared/rules'
import { DEFAULT_THREAD_DEFAULTS } from '@shared/defaults'
import { DEFAULT_PLAN_SETTINGS, type PlanScope } from '@shared/plans'
import type { ReviewScope } from '@shared/review'
import { ensureLinked, type EnsureLinkedDeps } from './projectLinks'
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
import { ATTACH_DIR, readAttachment, saveAttachment } from './attachments'
import { attachmentDir, dataAttachmentsRoot, setAttachmentDirContext, treeAttachmentsRoot } from './attachmentDir'
import { AttachmentUploads, handleAttachmentUploads, sweepAttachmentRoots } from './attachmentUploads'
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
import { eventsPage, eventsWindowMs, frameJson, profileFor, PushCoalescer, remoteDeflateOptions, sessionPage } from './wire'
import { FocusSet } from './focus'
import { bulkKey, LaneGate, laneOf } from './lane'
import { ListChangeLog } from './listChanges'
import { LaunchMirror } from './launchMirror'
import { peerDelay, peerDelayMs } from './peerDelay'
import type { WireProfile } from '@shared/wire'

/** The session an app.* call claims to be from — must actually exist. */
function callerOf(registry: SessionRegistry, sessionId: string): SessionMeta {
  const caller = registry.get(sessionId)
  if (!caller) throw new Error(`unknown session: ${sessionId}`)
  return caller
}

/** file.read is fenced to app-managed directories: project working trees
 *  (plan docs live there) and workspace roots (reports and angle files live
 *  there — for a worktree project that is outside its cwd). */
function readAllowedFile(registry: SessionRegistry, path: string): string | null {
  const abs = resolve(path)
  const roots = [
    ...registry.listProjects().map((p) => p.cwd),
    ...registry.listWorkspaces().map((w) => w.path)
  ]
  if (!withinRoots(abs, roots)) throw new Error('path outside app-managed directories')
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
  /** This server's stable identity (<userData>/environment.json). */
  environmentId: string
  /** Serve the contract on a socket that already authenticated as `principal`. */
  attach: (ws: WebSocket, principal: Principal) => void
  /** A thread someone is looking at (session.focus on any socket), its subagents
   *  or a focused master's batch (focus.ts): the scheduler's `focused` hook. */
  isInteractive: (sessionId: string) => boolean
  /** Keys, pairings, sessions and tickets for the fixed port (remote/auth.ts). */
  remoteAuth: RemoteAuth
  /** The fixed port's listener, or null while remote access is off. */
  readonly remote: RemoteListener | null
  registry: SessionRegistry
  store: Store
  gateway: Gateway
  /** Optional off-host relay; the notifier sends notices through this client. */
  hub: HubClient | null
  /** Thread transitions as notices (needs_you, finished, failed, stuck); subscribe with onNotice. */
  notifier: Notifier
  /** The shared Aliax accounts poll; the embedded Aliax pages nudge it after a change. */
  accounts: AccountsService
  /** The app's notes, so a proof can seed one in-process. */
  notes: Notes
  /** Account ownership and sync with the hosts this machine holds admin keys for (remote/accountSync.ts). */
  accountSync: AccountSync
  /** The project linker over this host's peer links (remote/projectLinks.ts); `statusAll()` for a surface. */
  projectLinker: ProjectLinker
  /** What this host runs: the hello's `build` (buildInfo.ts). */
  build: BuildFacts
  /** Master's release number from GitHub (deployDrift.ts); `focus()` when a window comes forward. */
  masterRelease: MasterReleaseWatcher
  /** The Mac bridge (remote/macBridge.ts); a proof seeds calls through it (TEMP_CODE_E2E_SEED). */
  macBridge: MacBridge
  /** What the desktop paints at boot before any socket is up (launchMirror.ts). */
  launchMirror: LaunchMirror
  /** The box side of the relay (remote/relay.ts): the relayed hosts' presence and the phones' lanes. */
  relay: HostRelay
  /** The host side of the relay (remote/relayServe.ts): lanes this host serves for a carrier. */
  relayServer: RelayServer
  /** This host's screen and power state (src/main/presence.ts). */
  presence: PresenceSource
  /** A stored agent page of a thread on `host`, over the peer link; null when the host has no such page. */
  remotePage: (host: string, sessionId: string, pageId: string) => Promise<string | null>
  /** A slice of a media file on `host` by its token, over the peer link; null when the host has no such token. */
  remoteMedia: (host: string, token: string, offset: number, length: number) => Promise<MediaRange | null>
  /** The master threads' batch engine (batch.ts); proofs seed a row through `seedRow`. */
  batches: Batches
  /** The thread resources ledger (threadResources.ts); proofs record rows through `record`. */
  resources: ThreadResources
  /** The devices hub (devices/hostDevices.ts), over the `devices` option's gatherer. */
  hostDevices: HostDevicesHub
  /** The project plans (projectPlan.ts); proofs pin and link through it. */
  projectPlans: ProjectPlans
  close: () => Promise<void>
}

let firstListMarked = false
/** Read once: a slow remote peer for the launch-mirror proof (peerDelay.ts). */
const PEER_DELAY_MS = peerDelayMs()
/** WS requests slower than this land in the boot log. */
const SLOW_REQUEST_MS = 500

/**
 * TEMP_CODE_DROP_ANSWERS=method:count[,method:count], isolated instances
 * only (TEMP_CODE_USER_DATA): the first `count` answers to `method` are
 * never sent, so a proof can drive a client through a lost response
 * (scripts/e2e-accounts-sync.ts, the takeover whose confirm answer drops).
 */
const dropAnswers = new Map<string, number>()
if (process.env.TEMP_CODE_USER_DATA && process.env.TEMP_CODE_DROP_ANSWERS) {
  for (const part of process.env.TEMP_CODE_DROP_ANSWERS.split(',')) {
    const [method, count] = part.split(':')
    if (method?.trim()) dropAnswers.set(method.trim(), Number(count) || 1)
  }
}
const dropAnswer = (method: string): boolean => {
  const left = dropAnswers.get(method) ?? 0
  if (left <= 0) return false
  dropAnswers.set(method, left - 1)
  return true
}

export async function startServer(
  dbPath: string,
  options: {
    dataDir?: string
    appPath?: string
    claimShim?: boolean
    /** The fixed port's override (tests: 0 for an ephemeral port). Absent: TEMP_CODE_REMOTE_PORT, else the settings. */
    remotePort?: number
    /** The tempcode-asset:// handler, so `/asset/*` on the fixed port can mirror logos, media and agent pages. */
    assets?: (request: Request) => Promise<Response>
    /** Read master's release.json from GitHub on the updater's cadence (deployDrift.ts): the Mac, never a headless host or a test. */
    watchMaster?: boolean
    /** Open the upstream socket an account's next request will ride (preconnect.ts) while the gateway runs in this process; its own process pre-connects its own pools. */
    preconnect?: (provider: string, account: string | null) => void
    /** Run the gateway's byte path in a utility process of its own (gatewayHost.ts); in this process when absent (tests, the in-process proofs). */
    spawnGatewayChild?: SpawnGatewayChild
    /** This app's updater (update.ts selfUpdate): fetch a version just published, by this host's Publisher or on a peer's word. The installed Mac app only. */
    selfUpdate?: (version: string) => Promise<SelfUpdateOutcome>
    /** The local devices gatherer, in place of the `isMacHost()` pick: a proof injects a fake on Linux (scripts/ios-client-test-server.ts); null for none. */
    devices?: MacDevices | null
    /** This host's screen and power state for the relay (src/main/presence.ts); default unknown/awake, never changing. */
    presence?: PresenceSource & { set?: (patch: Partial<Pick<MacPresence, 'screen' | 'power'>>) => MacPresence }
  } = {}
): Promise<RunningServer> {
  bootMark('server-start')
  const db = openDb(dbPath)
  bootMark('db-open')
  // WAL checkpoints of both files run on a worker's own connection; the
  // writer keeps a 10,000-frame backstop and takes the work back if the
  // worker dies (dbWorkers.ts).
  const checkpointWorker = startCheckpointWorker(db, dbPath)
  // Session search runs on a read-only connection in a second worker; the
  // writer opened WAL first, so the -shm file the read-only open needs is there.
  const reader = new EventReader(dbPath)
  const store = new Store(db, { reader })
  const environmentId = loadEnvironmentId(options.dataDir ?? dirname(dbPath))
  // What this host runs, said in every hello; and master's number, so the
  // renderer can mark a host that is behind (src/shared/deployDrift.ts).
  const build = buildFacts(options.appPath)
  const localSinks = new Set<(push: ServerPush) => void>()
  const masterRelease = new MasterReleaseWatcher({
    onChange: (master) => {
      for (const sink of localSinks) sink({ push: 'deploy-master', master })
    },
    log: (line) => console.log(line)
  })
  if (options.watchMaster) masterRelease.start()
  const checkpoints = new CheckpointStore(join(options.dataDir ?? dirname(dbPath), 'checkpoints'))
  /** Each socket's `checkpoint-changed` filter: frames for the threads it subscribed to. */
  const checkpointSinks = new Set<(sessionId: string, push: ServerPush) => void>()
  // Undo checkpoints from the host's own turns: armed at every send, written
  // when a turn settles, in the thread's cwd (checkpointTurns.ts).
  const checkpointTurns = new CheckpointTurns({
    store: checkpoints,
    session: (id) => store.getSession(id),
    listTracked,
    inHeadMany,
    push: (sessionId, push) => {
      for (const sink of checkpointSinks) sink(sessionId, push)
    }
  })
  const registry = new SessionRegistry(store)
  // The threads people are looking at (session.focus), widened to their
  // subagents and a focused master's batch: their requests and pushes go first.
  const focus = new FocusSet({ parentOf: (id) => registry.parentOf(id), masterOf: (id) => registry.masterOf(id) })
  // A send on a thread someone is looking at is admitted over the running cap (scheduler.ts).
  registry.scheduler.focused = (id) => focus.isInteractive(id)
  // The bulk lane, one per host: polls and walks wait while the loop lags (lane.ts).
  const laneGate = new LaneGate()
  setLaneStats(() => laneGate.stats())
  // The temp-code workspace's default preamble, seeded once (projectPreamble.ts).
  seedHousePreamble(store)
  migrateHousePreamble(store)
  // The project plan's pin, ticks and milestone links (projectPlan.ts).
  const projectPlans = new ProjectPlans(store, {
    getProject: (id) => registry.getProject(id),
    sessionsOfProject: (id) => store.sessionsOfProject(id),
    getSession: (id) => registry.get(id)
  })
  setProjectPlans(projectPlans)
  const launchMirror = new LaunchMirror(db)
  // The list change log a client's launch mirror resumes from (`session.changes`).
  const listChanges = new ListChangeLog()
  registry.onMeta((m) => listChanges.changed(m.id))
  registry.onRemoved((ids) => listChanges.removed(ids))
  // The file viewer's media host serves only files under these roots, and
  // names this host on every URL so another host's desktop reads from here.
  setMediaHost(environmentId)
  setMediaRoots(() => [
    ...registry.listProjects().map((p) => p.cwd),
    ...registry.listWorkspaces().map((w) => w.path)
  ])
  /** What a remote key may name by path (remote/fence.ts): the media
   *  roots plus the work root new workspaces go under — unless that is the
   *  bare home directory, which no key gets to browse. */
  const managedRoots = (): string[] => {
    const work = workRoot(store)
    return [
      ...registry.listProjects().map((p) => p.cwd),
      ...registry.listWorkspaces().map((w) => w.path),
      ...(work.root !== work.home ? [work.root] : []),
      // A thread with no project or workspace keeps its uploads here.
      dataAttachmentsRoot()!,
      // Files fetched from the Mac for a thread with no project or workspace (macBridgeLanding.ts).
      macBridgeLandingRoot(options.dataDir ?? dirname(dbPath))
    ]
  }
  // Each thread's uploaded attachments (attachmentDir.ts): under its project
  // cwd, else its workspace path, else <userData>/attachments.
  setAttachmentDirContext({
    session: (id) => store.getSession(id),
    projectCwd: (id) => store.getProject(id)?.cwd,
    workspacePath: (id) => registry.listWorkspaces().find((w) => w.id === id)?.path,
    dataDir: options.dataDir ?? dirname(dbPath)
  })
  // TEMP_CODE_ATTACHMENT_TTL_MS: a proof's short expiry (scripts/e2e-attachments.ts); the sweep then runs at a tenth of it.
  const uploadTtl = Number(process.env.TEMP_CODE_ATTACHMENT_TTL_MS) || undefined
  const uploads = new AttachmentUploads({
    dirFor: (sessionId) => attachmentDir(sessionId),
    store,
    ...(uploadTtl ? { ttlMs: uploadTtl, sweepEveryMs: Math.max(100, Math.floor(uploadTtl / 10)) } : {})
  })
  registry.onRemoved((ids) => uploads.dropSessions(ids))
  /** Every per-tree attachments root plus the userData one: what the retention sweep walks. */
  const attachmentRoots = (): string[] => [
    ...registry.listProjects().map((p) => treeAttachmentsRoot(p.cwd)),
    ...registry.listWorkspaces().map((w) => treeAttachmentsRoot(w.path)),
    dataAttachmentsRoot()!
  ]
  setLimitMissLog(join(options.dataDir ?? dirname(dbPath), 'logs'))
  setCodexBootFailureLog(join(options.dataDir ?? dirname(dbPath), 'logs'))
  const logDir = join(options.dataDir ?? dirname(dbPath), 'logs')
  setStallLog(logDir)
  configureHostProfiler(logDir)
  setRunningCount(() => registry.runningCount())
  const stopStallMonitor = startStallMonitor()
  registry.checkpoints = checkpointTurns
  registry.onEvent((row) => void checkpointTurns.observe(row))
  const offCheckpointEdits = onLiveEdit((push) => void checkpointTurns.liveEdit(push))
  // What every host's gateway has seen of each account's rate limits: the
  // routing score reads it, the chip's bars show it, and a 429 re-picks at once.
  const headroom = new HeadroomStore({
    environmentId,
    file: join(options.dataDir ?? dirname(dbPath), 'headroom.json'),
    onThrottle: (service, account, event) => {
      console.log(`[gateway] ${service}: ${account} answered ${event.status}; out of new picks until ${new Date(event.until).toISOString()}`)
      accounts.nudge()
      accountSync.pushHeadroomSoon()
    },
    log: (line) => console.log(`[headroom] ${line}`)
  })
  const accounts = new AccountsService({
    load: (provider) => registry.liveLoad(provider),
    homes: () => accountSync.homes(),
    peers: () => peers.states(),
    headroom: () => headroom
  })
  registry.limits = accounts
  // An account gone from the vault explains a thread's 401 outright; with
  // no snapshot yet the host cannot say either way.
  registry.accountKnown = (provider, name) => {
    const profiles = accounts.snapshot().providers[provider]?.profiles ?? []
    return profiles.length === 0 ? null : profiles.some((p) => p.name === name)
  }
  // The registry asks at turn start and composer focus; the gateway sends it where its pools live.
  registry.preconnect = (provider, account) => void runningGateway()?.preconnect(provider, account)
  // The main process's own links to the hosts this machine shares accounts
  // with, and the sync over them (thread V). The core's vault hooks reach the
  // sync through accountSyncHooks (aliax.ts configured the core before this).
  // The relay, this host's side (remote/relayServe.ts, docs/box.md "The relay"):
  // lanes a carrier (the box) opens for its phones and bots, served by this
  // host's own attach(), and this host's presence published on every link.
  const presence = options.presence ?? new MacPresenceWatcher({ initial: { screen: 'unknown', power: 'awake' } })
  const relayServer = new RelayServer({
    environmentId,
    attach: (ws, principal) => attach(ws as unknown as WebSocket, principal, 'remote'),
    link: (id) => {
      const link = peers.get(id)
      return link?.connected ? (method, params, opts) => link.request(method, params, opts) : null
    },
    environments: () => listEnvironments(store).map((e) => ({ id: e.id, name: e.name })),
    presence,
    facade: () => ({ registry, origin: null, environmentId }),
    deliversNotices: () => apns !== null || hub !== null,
    build
  })
  const peers = new Peers(
    { store, environmentId },
    {
      onOpen: (id) => {
        void accountSync.syncWith(id)
        void accountSync.pushHeadroom(id)
        void harnessSync.syncWith(id, 'link-up')
        void memorySync.syncWith(id, 'link-up')
        projectLinker.linkUp(id)
        projectSettings.linkUp(id)
        rulesSync.linkUp(id)
        void sessionMover.settleWith(id)
        relayServer.linkUp(id)
        void macBridge.linkUp(id)
        peerDeploy.linkUp(id)
        accounts.nudge()
      },
      onClose: (id) => {
        relayServer.linkDown(id)
        macBridge.linkDown(id)
        macPorts.linkDown(id)
        accounts.nudge()
      },
      onPush: (from, push) => {
        projectLinker.onPeerPush(from, push)
        projectSettings.onPeerPush(from, push)
        rulesSync.onPeerPush(from, push)
        // A linked host's dev servers, forwarded here (remote/macPorts.ts).
        if (push.push === 'ports') return void macPorts.onPorts(from, push.ports)
        if (push.push === 'ports.data') return macPorts.onData(from, push.streamId, push.seq, push.data)
        if (push.push === 'ports.close') return macPorts.onClose(from, push.streamId, push.seq, push.error)
        if (relayServer.onPeerPush(from, push)) return
        if (hostDevices.onPeerPush(from, push)) return
        if (crossHostThreads.onPeerPush(from, push)) return
        if (crossHostAgents.onPeerPush(from, push)) return
        if (macPublish.onPeerPush(from, push)) return
        if (memorySync.onPeerPush(from, push)) return
        if (releaseAnnouncer.onPeerPush(from, push)) return
        if (peerDeploy.onPeerPush(from, push)) return
        if (!macBridge.onPeerPush(from, push)) accountSync.onPeerPush(from, push)
      }
    }
  )
  const accountSync: AccountSync = new AccountSync({ environmentId, store, peers, nudge: () => accounts.nudge(), refreshNow: () => accounts.rebuildNow(), headroom })
  accountSyncHooks.current = accountSync
  // The user's Claude Code and Codex config, mirrored onto the same hosts
  // (remote/harnessSync.ts). A headless host (the box) receives and does not send.
  const harnessSync = new HarnessSync({
    environmentId,
    store,
    peers,
    dataDir: options.dataDir ?? dirname(dbPath),
    defaultEnabled: !isHeadless(),
    workRoot: () => workRoot(store).root
  })
  harnessSync.start()
  // Deploy and publish from the app (hostJobs.ts): the box's trigger
  // directory and the Mac's release scripts, each a log sockets may tail.
  const hostJobs: HostJobs = { deploy: new DeployTrigger({ version: appVersion }), publish: new Publisher({ store, selfUpdate: options.selfUpdate }) }
  // The harnesses' own notes (Claude Code's per-project memory and plans,
  // Codex's memories; remote/memorySync.ts) cross both ways: this host
  // drives over the links it holds, and nudges the hosts linked to it.
  const memorySync = new MemorySync({
    environmentId,
    store,
    peers,
    dataDir: options.dataDir ?? dirname(dbPath),
    pathMap: () => harnessSync.pathMap(),
    workRoot: () => workRoot(store).root,
    nudgePeers: (frame) => peerCalls.notify(frame)
  })
  memorySync.start()
  // One project across hosts (remote/projectLinks.ts): over the links this
  // host holds, pair its workspaces and projects with the peer's and stamp
  // the link ids both copies share.
  const projectLinker = new ProjectLinker({ environmentId, platform: hostPlatform(), registry, peers })
  projectLinker.start()
  // A linked project's settings live on its home, the box
  // (remote/projectSettingsSync.ts): this host follows the home's copy and
  // sends every settings write of such a project there.
  const projectSettings = new ProjectSettingsSync({ environmentId, platform: hostPlatform(), registry, store, peers })
  projectSettings.start()
  // Orchestration rules and thread defaults: one copy, on the same home
  // (remote/rulesSync.ts).
  const rulesSync = new RulesSync({ environmentId, platform: hostPlatform(), registry, store, peers })
  rulesSync.start()
  // Moving one thread between this host and a peer (remote/sessionMover.ts).
  const sessionMover = new SessionMover({
    host: {
      db,
      environmentId,
      // The worktree the branch step makes for a landed thread is the thread's own from then on (threadResources.ts).
      recordResource: (sessionId, r) =>
        void resources.record(sessionId, environmentId, {
          created: [{ kind: 'worktree', identifier: r.path, label: r.branch ?? basename(r.path), branch: r.branch }],
          removed: []
        }),
      dataDir: options.dataDir ?? dirname(dbPath),
      home: () => homedir(),
      workRoot: () => workRoot(store).root,
      pathMap: () => harnessSync.pathMap(),
      claudeDir: claudeConfigDir,
      codexDir: codexHomeDir,
      forget: (ids) => store.forgetSessions(ids),
      projectLink: (projectId) => registry.projectLinkFacts(projectId),
      ensureLinked: (args) => ensureLinked(linkedCopies, args)
    },
    registry,
    peers,
    flush: () => store.flushEvents()
  })
  sessionMover.thawStale()
  const peerCalls = new PeerCalls(environmentId)
  // How another host's main process is reached, whichever way the socket runs
  // (remote/hostLinks.ts): a peer.call down a socket it registered here, or a
  // request on its listener over this host's own link to it.
  const peerRequest = (id: string): LinkRequest | null => {
    const link = peers.get(id)
    return link?.connected ? (method, params, opts) => link.request(method, params, opts) : null
  }
  const hostLinks = new HostLinks({ calls: peerCalls, offer: CROSS_HOST_OFFER, link: peerRequest, linkIds: () => listEnvironments(store).map((e) => e.id) })
  // The hosts this one knows: the ones it saved (and dials), and the ones
  // that dialed it and registered (the Mac on the box), named by their key.
  const knownHosts = (): { id: string; name: string }[] => {
    const saved = listEnvironments(store).map((e) => ({ id: e.id, name: e.name }))
    const registered = peerCalls.registeredIds().filter((id) => !saved.some((e) => e.id === id)).map((id) => ({ id, name: peerCalls.nameOf(id) ?? id }))
    return [...saved, ...registered]
  }
  const hostNameOf = (id: string): string | null => knownHosts().find((e) => e.id === id)?.name ?? null
  // The Mac bridge (docs/box.md): this host as the Mac, answering the hosts it
  // links to under its own policy; and as the box, asking a registered Mac.
  const macBridge = new MacBridge({
    environmentId,
    store,
    managedRoots: () => managedRoots(),
    environments: () => listEnvironments(store).map((e) => ({ id: e.id, name: e.name })),
    link: (id) => {
      const link = peers.get(id)
      return link?.connected ? (method, params, opts) => link.request(method, params, opts) : null
    },
    offers: () => [...crossHostOffers(), ...hostDevicesOffers(), ...macPublishOffers(), ...relayOffers(), PORTS_OFFER],
    // The thread cap counts the threads a host started here that are live (crossHostThreads below).
    liveThreads: (envId) => crossHostThreads.liveThreadsOf(envId),
    // The relay's host row on the carrier: this host's name, presence and build.
    registration: () => relayServer.registration()
  })
  // Threads another host starts here (docs/box.md "Threads across hosts"):
  // served over the Mac's link as peer.call pushes, and on this listener as
  // thread.* requests from a registered peer. The Mac bridge's thread cap
  // admits them on a Mac; the box keeps its own (crossHost.maxThreads.<envId>).
  // One project across hosts: this host's copy of a caller's linked project,
  // found or made (projectLinks.ts), for a far start and project.ensureLinked.
  const linkedCopies: EnsureLinkedDeps = {
    listProjects: () => registry.listProjects(),
    listWorkspaces: () => registry.listWorkspaces(),
    createWorkspace: (path, opts) => registry.createWorkspace(path, undefined, opts),
    createProject: (workspaceId, name, mode, opts) => registry.createProject(workspaceId, name, mode, opts),
    linkCatalog: (args) => registry.linkCatalog(args),
    pathMap: () => harnessSync.pathMap(),
    workRoot: () => workRoot(store).root
  }
  const crossHostThreads = new CrossHostThreads({
    environmentId,
    store,
    registry,
    ensureLinked: (args) => ensureLinked(linkedCopies, args),
    environments: knownHosts,
    link: peerRequest,
    links: hostLinks,
    pathMap: () => harnessSync.pathMap(),
    workRoot: () => workRoot(store).root,
    ...(isMacHost() ? { admit: (envId: string) => macBridge.admitThread(envId) } : {}),
    // thread.read: a reference from another host gets the digest a local one would.
    digest: (meta) => ({
      digest: cappedThreadDigest(registry, meta),
      projectName: meta.projectId ? (registry.getProject(meta.projectId)?.name ?? null) : null
    })
  })
  // A batch's publish step, served on this Mac for the box (remote/macPublish.ts):
  // the box cut and pushed the release; the Mac pulls it and runs release:publish.
  const macPublish = new MacPublish({
    environmentId,
    environments: () => listEnvironments(store).map((e) => ({ id: e.id, name: e.name })),
    link: (id) => {
      const link = peers.get(id)
      return link?.connected ? (method, params, opts) => link.request(method, params, opts) : null
    },
    publisher: hostJobs.publish
  })
  // Every remote client socket of this host, for the relay's presence push.
  const remoteSinks = new Set<(push: ServerPush) => void>()
  // The relay, the carrier's side (remote/relay.ts): a phone or bot paired
  // with this host reaches a host that registered with the relay offer.
  const hostRelay = new HostRelay({
    environmentId,
    transport: new PeerRelayTransport(peerCalls, environmentId),
    calls: peerCalls,
    store,
    broadcast: (push) => {
      for (const sink of remoteSinks) sink(push)
    },
    pushLocal: async (req, principal) => {
      const answer = await handleRemote(req, { ...remoteContext, ceiling: principal.caps, createdBy: principal.keyId })
      if (!answer.handled) throw new Error(`${req.method} is not answered here`)
      return answer.result
    },
    deliverNotice: async (from, relayed) => {
      const hostId = process.env.TEMP_CODE_HUB_HOST_ID || environmentId
      // An older host sends no kind: read it off the event.
      const n = { ...relayed, kind: relayed.kind ?? (relayed.event === 'needs_you' ? ('waiting' as const) : relayed.event) }
      const jobs: Promise<unknown>[] = []
      if (hub) jobs.push(hub.notify({ ...n, environmentId: from }))
      if (apns) jobs.push(pushRegistry.deliver({ ...n, environmentId: from }))
      const targets = remoteAuth.webhookTargets(n.event)
      if (targets.length > 0) jobs.push(deliverWebhooks(targets, webhookPayload(n, hostId, from)))
      await Promise.all(jobs)
    },
    contract: CONTRACT_VERSION
  })
  // Devices on a Mac (devices/hostDevices.ts, docs/box.md "Devices on the Mac"):
  // gathered on this Mac while a viewer is open, or asked of a registered Mac
  // over the peer link; the ledger join names the thread that holds each one.
  const sessionLookup = (id: string): { title: string; status: string } | null => {
    const meta = store.getSession(id)
    return meta ? { title: meta.title, status: meta.status } : null
  }
  const macDevices =
    options.devices !== undefined
      ? options.devices
      : isMacHost()
        ? new MacDevices({ environmentId, ledger: () => readSimulatorHolders(db, environmentId), session: sessionLookup })
        : null
  const hostDevices = new HostDevicesHub({
    environmentId,
    local: macDevices,
    peers: peerCalls,
    hostName: (id) => listEnvironments(store).find((e) => e.id === id)?.name ?? null,
    ledgerFor: (id) => readSimulatorHolders(db, id),
    session: sessionLookup,
    localName: 'This Mac',
    link: (id) => {
      const link = peers.get(id)
      return link?.connected ? (method, params) => link.request(method, params) : null
    },
    environments: () => listEnvironments(store).map((e) => ({ id: e.id, name: e.name }))
  })
  // A running mac_run's output, live on its thread's tool row (macRunLive.ts).
  const macRunCalls = new MacRunCalls()
  registry.onEvent((row) => macRunCalls.observe(row))
  const macRunLive = new MacRunLive({ emit: (id, event) => registry.append(id, event), calls: macRunCalls })
  const macTokens = MacThreadTokens.fromEnv()
  // The ledger of what a thread created, here or on the Mac (threadResources.ts):
  // fed by the event stream and by every mac.run; removal runs on the owning host.
  const resources = new ThreadResources({
    db,
    environmentId,
    sessions: { get: (id) => registry.get(id) },
    homeOf: (id) => (id === environmentId ? homedir() : peerCalls.homeOf(id)),
    runOn: async (hostId, thread, argv, cwd) => {
      if (hostId === environmentId) {
        const r = await runMacCommand({ argv, cwd, timeoutMs: 120_000 }).result
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
      }
      if (!peerCalls.online(hostId, MAC_BRIDGE_OFFER)) throw new OfflineError(hostId)
      const r = await peerCalls.call<MacRunResult>(
        hostId,
        'mac.run',
        { thread: { id: thread.id, title: thread.title, permission: thread.permission }, args: { argv, cwd, timeoutMs: 120_000 } },
        MAC_APPROVAL_WAIT_MS + 120_000 + 5_000
      )
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
    }
  })
  registry.onEvent((row) => resources.observeEvent(row))
  // Dev servers (docs/box.md "Dev servers on the box"): a thread's ports land in the
  // ledger (threadPorts.ts), go to every registered Mac (remote/portForward.ts), and
  // the thread hears the Mac's URL (portTail.ts).
  const listenerScanner = new SharedScanner()
  const threadPorts = new ThreadPorts({ resources, environmentId, harnessPid: (id) => registry.harnessPid(id), scanner: listenerScanner })
  registry.onEvent((row) => threadPorts.observeEvent(row))
  const threadTitle = (id: string): string => registry.get(id)?.title ?? 'Thread'
  /** A dev run's ports (devRuns below fills it in). */
  const devPortOffers: { current: () => ForwardedPort[]; bound: (ids: string[]) => void } = { current: () => [], bound: () => {} }
  const portOffers = (): ForwardedPort[] => [
    ...resources.listAll({ kind: 'port', environmentId }).map((r) => ({
      id: r.id,
      port: Number(r.identifier),
      label: r.label,
      title: threadTitle(r.sessionId),
      sessionId: r.sessionId,
      runId: null
    })),
    ...devPortOffers.current()
  ]
  const portHost = new PortForwardHost({
    environmentId,
    offers: portOffers,
    macs: () => peerCalls.registeredIds(PORTS_OFFER),
    push: (id, frame) => peerCalls.push(id, frame),
    buffered: (id) => peerCalls.buffered(id),
    hostName: (id) => peerCalls.nameOf(id) ?? listEnvironments(store).find((e) => e.id === id)?.name ?? null
  })
  // The Dev Server button's runs (devRuns.ts): their ports join the list the Macs get.
  const devRuns = new DevRuns({
    project: (id) => registry.getProject(id),
    scanner: listenerScanner,
    forwardsOf: (id) => portHost.forwardsOf(id),
    offersChanged: () => portHost.refresh(),
    env: () => harnessEnv()
  })
  devPortOffers.current = () => devRuns.offers()
  // The host-wide sweep (portSweep.ts): servers a background shell started, reparented to init.
  const portSweep = new PortSweep({
    resources,
    environmentId,
    scanner: listenerScanner,
    threads: () =>
      registry.list({ archived: false }).map((m) => {
        const harnessPid = registry.harnessPid(m.id)
        return { id: m.id, cwd: m.cwd, harnessPid, live: harnessPid !== null || LIVE_STATUSES.has(m.status), createdAt: m.createdAt, activeAt: m.updatedAt }
      }),
    anyLive: () => registry.harnessPids().length > 0,
    claimed: (port) => devRuns.offers().some((o) => o.port === port),
    recorded: () => threadPorts.arm()
  })
  registry.onEvent((row) => portSweep.observeEvent(row))
  threadPorts.onCallEnd(() => portSweep.callEnded())
  portSweep.start()
  // An agent's dev server's console (portLog.ts): its output file, else the call's output.
  const callOutputs = new Map<string, { output: string | null; at: number }>()
  const portLogs = new PortLogs({
    row: (id) => resources.get(id),
    scanner: listenerScanner,
    callFile: (row) => (row.callId ? portSweep.fileOfCall(row.callId) : null),
    callOutput: (row) => {
      if (!row.callId) return null
      const known = callOutputs.get(row.callId)
      if (known && (known.output !== null || Date.now() - known.at < 5_000)) return known.output
      const sessionId = threadPorts.sessionOfCall(row.callId) ?? row.sessionId
      let output: string | null = null
      for (const r of registry.lastEvents(sessionId, 5_000))
        if (r.event.type === 'tool-result' && r.event.callId === row.callId) output = r.event.output
      callOutputs.set(row.callId, { output, at: Date.now() })
      if (callOutputs.size > 256) callOutputs.delete(callOutputs.keys().next().value as string)
      return output
    }
  })
  devPortOffers.bound = (ids) => devRuns.bound(ids)
  resources.decorate = (r) => (r.kind === 'port' && r.environmentId === environmentId ? { ...r, forwards: portHost.forwardsOf(r.id) } : r)
  resources.onChange(() => portHost.refresh())
  peerCalls.onRegister((id, offers) => {
    if (offers.has(PORTS_OFFER)) portHost.macRegistered(id)
  })
  peerCalls.onDrop((id) => portHost.macDropped(id))
  const portTail = new PortTail({
    settle: (sessionId, callId, output) => threadPorts.settle(sessionId, callId, output),
    whenBound: (ids, ms) => portHost.whenBound(ids, ms),
    forwardsOf: (id) => portHost.forwardsOf(id),
    row: (id) => {
      const r = resources.get(id)
      return r && r.removedAt === null ? r : null
    },
    running: (callId) => threadPorts.running(callId),
    sessionOfCall: (callId) => threadPorts.sessionOfCall(callId),
    whisper: (sessionId, text) => registry.whisper(sessionId, text)
  })
  registry.toolResultTail = (sessionId, callId, output) => portTail.tail(sessionId, callId, output)
  threadPorts.onCallEnd((_sessionId, callId) => portTail.callEnded(resources.listAll({ kind: 'port', environmentId }).filter((r) => r.callId === callId).map((r) => r.id)))
  portHost.onBound((ids) => {
    portTail.bound(ids)
    const owners = new Set<string>()
    for (const id of ids) {
      const r = resources.get(id)
      if (r) owners.add(r.sessionId)
    }
    for (const o of owners) resources.notify(o)
    devPortOffers.bound(ids)
  })
  // The Mac side: the hosts this machine links to forward their ports here (remote/macPorts.ts).
  const macPorts = new MacPortForwards({
    environmentId,
    link: (id) => {
      const link = peers.get(id)
      return link?.connected ? { request: (method, params, opts) => link.request(method, params, opts), buffered: () => link.buffered() } : null
    },
    hosts: () => peers.all().map((l) => ({ id: l.id, name: l.env.name, connected: l.connected })),
    enabled: (id) => store.getSetting(forwardSettingKey(id)) !== 'off',
    setEnabled: (id, on) => store.setSetting(forwardSettingKey(id), on ? 'on' : 'off')
  })
  macPorts.onChange((hosts) => {
    for (const sink of localSinks) sink({ push: 'port-forwards', hosts })
  })
  // The Mac bridge's peer.register carries the offer; the host's list follows on its own.
  // The fleet's Archive done (session.batch with cleanup, sessionBatch.ts) removes each archived thread's resources.
  registry.resourceCleanup = async (sessionId) => {
    await resources.remove(sessionId)
  }
  peerCalls.onRegister((id, offers) => {
    if (offers.has(MAC_BRIDGE_OFFER)) void resources.linkUp(id)
  })
  // How many Mac calls a paused thread's tree holds (macPause.ts): every client hears it, for the paused strip.
  const heldListeners = new Set<(push: MacHeldPush) => void>()
  const macTools = new MacTools({
    store,
    sessions: registry,
    landing: { getProject: (id) => registry.getProject(id), getWorkspace: (id) => registry.listWorkspaces().find((w) => w.id === id) },
    dataDir: options.dataDir ?? dirname(dbPath),
    calls: peerCalls,
    resources,
    tokens: macTokens,
    reboot: (id) => rebootWhenSettled(registry, id, (status) => LIVE_STATUSES.has(status)),
    live: macRunLive,
    heldChanged: (sessionId, held) => {
      for (const l of heldListeners) l({ push: 'macBridge.held', sessionId, held })
    }
  })
  macToolsHooks.current = macTools
  macToolsHooks.tokens = macTokens
  // The box side: a thread here starting or spawning on a registered Mac,
  // reached by the app tools (apptools.ts, orchestration.ts).
  // Notices name this host as the environment switcher does.
  registry.hostName = () => hostname()
  const crossHostAgents = new CrossHostAgents({
    environmentId,
    store,
    sessions: registry,
    links: hostLinks,
    link: peerRequest,
    macPeerOf: (id) => macTools.macPeerOf(id).macPeer,
    hostName: hostNameOf,
    workRoot: () => workRoot(store).root,
    projectLink: (projectId) => registry.projectLinkFacts(projectId),
    // A batch child on another host landing, or changing state: the engine here (batch.ts) decides and reviews.
    landing: (l) => batchRuns.remoteLanding(l),
    batchChanged: (masterId) => batchRuns.schedule(masterId)
  })
  setCrossHostAgents(crossHostAgents)
  setAppCrossHost(crossHostAgents)
  // `@thread:<host>:<id>` references in a message (sessions.ts send).
  registry.readForeignThread = (caller, envId, sessionId) => crossHostAgents.readThread(caller, envId, sessionId)
  // A master's batch (batch.ts): the steps its children never run; merge_branch
  // tells it what landed. Review before merge (mergeReview.ts): merge_branch's
  // engine, one per host, the gate out of the children inside it.
  // The publish step's job and the deploy step's trigger by host: on the box the
  // Mac's Publisher over the peer link and the local trigger; on the Mac its own
  // Publisher and the box's trigger over the Mac's link (remote/peerDeploy.ts).
  // A release landing is told to the installed app (releaseAnnounce.ts).
  const peerPublish = new PeerPublish({ environmentId, calls: peerCalls, macPeerOf: (id) => macTools.macPeerOf(id).macPeer })
  const localPublish = new LocalPublish(macPublish, { stop: () => hostJobs.publish.stop() })
  const peerDeploy = new PeerDeploy({
    links: () => listEnvironments(store).filter((e) => peers.get(e.id)?.connected).map((e) => ({ id: e.id, name: e.name })),
    link: (id) => {
      const link = peers.get(id)
      return link?.connected ? (method, params, opts) => link.request(method, params, opts) : null
    },
    log: (line) => console.log(line)
  })
  const releaseAnnouncer = new ReleaseAnnouncer({
    environmentId,
    notify: (frame) => peerCalls.notify(frame),
    selfUpdate: options.selfUpdate,
    log: (line) => console.log(line)
  })
  const onMac = isMacHost() && !isHeadless()
  const batchRuns = new Batches({
    environmentId,
    registry,
    store,
    deploy: onMac && !hostJobs.deploy.installed() ? peerDeploy : hostJobs.deploy,
    publish: onMac ? localPublish : peerPublish,
    announce: (version) => releaseAnnouncer.announce(version),
    version: appVersion,
    // The batch's children on other hosts (crossHostAgents.ts): counted, paused, archived over their links.
    remote: {
      children: (masterId) => crossHostAgents.batchChildren(masterId),
      refresh: (masterId) => crossHostAgents.refreshBatch(masterId),
      act: (masterId, action, ids) => crossHostAgents.batchAction(masterId, action, ids),
      adopt: (master, ids) => crossHostAgents.adopt(master, ids),
      hostName: hostNameOf
    }
  })

  batchRuns.attach()
  setBatches(batchRuns)
  // A master's board in one answer (batch.board) and its pushes, only to
  // the sockets watching that master (boardDigest.ts, boardWatch.ts).
  const boardWatch = new BoardWatch(focus)
  const boardDigests = hostBoardDigests(registry, store, (masterId) => boardWatch.watched(masterId))
  boardDigests.attach()
  registry.onRemoved((sessionIds) => boardDigests.forget(sessionIds))
  // A thread of another host's batch lands by asking that host (remote/crossHostThreads.ts); a local one by the engine here.
  setMergeReviews(
    new MergeReviews({
      registry,
      store,
      onLanded: (l) => {
        if (!crossHostThreads.landingDone(l.session, l)) batchRuns.landed(l)
      },
      hold: (s, l) => (crossHostThreads.ownerOf(s.id) ? crossHostThreads.landingHold(s, l) : batchRuns.hold(s, l))
    })
  )
  // A thread that ends here (archived, deleted, moved away) takes its interactive jobs on the Mac with it.
  registry.onRemoved((ids) => macTools.threadsEnded(ids))
  registry.onMeta((m) => {
    if (m.archived) macTools.threadsEnded([m.id])
    memorySync.onSessionMeta(m)
    // Pause and resume follow the status: into paused cancels the tree's Mac work, out of it releases or refuses what waited.
    macTools.pause.onStatus(m.id, m.status)
  })
  peers.refresh()
  const syncTimer = setInterval(() => void accountSync.syncAll(), 15 * 60_000)
  syncTimer.unref()
  const m3a = { store, registry, notes: new Notes(db), logos: new ProjectLogos(options.dataDir ?? dirname(dbPath)), accounts, accountSync }
  // Every snapshot that changes what a thread could be routed to re-picks the
  // open threads' accounts (an empty one would pick nothing): the first
  // covers boot. A usage or headroom number moving is not such a change.
  accounts.onPickable((snapshot) => {
    if (Object.values(snapshot.providers).some((p) => p.profiles.length > 0)) registry.refreshAccounts()
  })
  accounts.start()
  const observed = observeHooks({ logDir: join(options.dataDir ?? dirname(dbPath), 'logs'), onObserved: () => accounts.nudge(), headroom })
  // Every answer moves the headroom picture; the rows follow at most every
  // 5 s (a pick reads the store live, so routing never waits for this).
  let headroomRows: NodeJS.Timeout | null = null
  const headroomChanged = (): void => {
    if (headroomRows) return
    headroomRows = setTimeout(() => {
      headroomRows = null
      accounts.nudge()
    }, 5_000)
    headroomRows.unref()
  }
  const gateway = await startGateway({
    claimShim: options.claimShim ?? false,
    dataDir: options.dataDir ?? dirname(dbPath),
    spawnChild: options.spawnGatewayChild,
    preconnect: options.preconnect,
    outMarks: () => accounts.outMarks(),
    hooks: {
      ...observed,
      onResponse: (info) => {
        observed.onResponse?.(info)
        if (info.account && isRoutedProvider(info.service)) headroomChanged()
        if (info.status < 400 && info.account && isRoutedProvider(info.service)) accounts.markAnswered(SERVICE_OF[info.service], info.account)
      },
      pickNext: (info) => {
        if (info.thread) registry.noteRefusal(info.thread, { status: 429, code: null, account: info.account })
        return accounts.pickNext(info)
      },
      // A dead sign-in answers 401 for good and core only fails over on 429:
      // the account leaves routing until it answers again, the request
      // replays under the best account with room, and with none left the
      // thread gets one row naming the account instead of codex's wording.
      substitute: (info) => accounts.substitute(info.serviceId, info.account, info.model),
      onUnauthorized: (info) => {
        registry.noteRefusal(info.thread, { status: 401, code: refusalCodeOf(info.body), account: info.account })
        if (accounts.markOut(info.serviceId, info.account)) console.log(`[gateway] ${info.service}: ${info.account} answered 401; out of routing until it answers again`)
        const next = accounts.substitute(info.serviceId, info.account, info.model)
        // The thread's own account, when it is the dead one: a substitute
        // dying later adds nothing the user can act on beyond that.
        if (!next) registry.signInNeeded(info.thread, accounts.outFor(PROVIDER_OF[info.serviceId]).includes(info.own) ? info.own : info.account)
        return next
      },
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
  // The gateway's own process reads the accounts from a copy main pushes. It reads
  // only what a pick reads (the profiles, the pin, the accounts out, the full
  // windows), so it follows the pickable set, not every usage number.
  accounts.onPickable(() => gateway.accountsChanged())
  const linear = new Linear(options.dataDir ?? dirname(dbPath))
  // Reads SQLite until the open inbox view asks it to refresh; no timer here.
  const githubInbox = new GithubInbox(store, registry)
  registry.resetStaleStatuses()
  registry.startIdleSweep()
  registry.startLivenessSweep()
  // The running cap (admission.ts): sized from memory unless pinned; the
  // scheduler holds every start past it.
  const admission = new Admission({
    getSetting: (key) => store.getSetting(key),
    setSetting: (key, value) => store.setSetting(key, value),
    pids: () => registry.harnessPids(),
    counts: () => registry.scheduler.counts(),
    onChange: () => registry.scheduler.schedule()
  })
  registry.admission = admission
  admission.start()
  // Threads the last shutdown cut mid-turn come back once everything
  // listens (run() below); the renderer hears the count once per boot.
  const bootResumer = new BootResumer({ store, registry })
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
      .then(() => runArchiveSweep())
  }, 2_000)
  foldTimer.unref()
  // Archived threads' logs move to the cold file in the background (the
  // first boot after the split moves every already-archived thread), and
  // idle trees get archived after the window: once after boot, then hourly.
  const coldMover = new ColdMover(store, {
    onProgress: ({ sessionId, moved, done }) => {
      if (done && moved > 0) console.log(`[cold] ${sessionId}: ${moved} rows moved`)
    }
  })
  registry.coldMover = coldMover
  let sweeping: Promise<void> | null = null
  const runArchiveSweep = (): Promise<void> =>
    (sweeping ??= (async () => {
      bootMark('cold-move start')
      await coldMover.kick()
      bootMark('cold-move done')
      // The FTS5 turn index (turnIndex.ts): every session it does not hold
      // yet, newest first, in the background; nothing on the first boot
      // after the upgrade has it, later only a moved or imported thread.
      bootMark('turn-index start')
      let indexedRows = 0
      await store.backfillTurnIndex({ onProgress: ({ rows }) => (indexedRows += rows) })
      bootMark('turn-index done', `${indexedRows} rows`)
      bootMark('archive-sweep start')
      const ids = await sweepArchive({
        store,
        list: () => registry.list({ archived: undefined }),
        queueList: (id) => registry.queueList(id),
        setArchived: (id, archived) => registry.setArchived(id, archived),
        checkpoints
      })
      bootMark('archive-sweep done', `${ids.length} archived`)
      await coldMover.kick()
      // Attachments of a thread archived 30 days ago, and directories no thread owns.
      const swept = await sweepAttachmentRoots(attachmentRoots(), (id) => {
        const meta = store.getSession(id)
        return meta ? { archived: meta.archived, updatedAt: meta.updatedAt } : null
      })
      if (swept.length) console.log(`[attachments] swept ${swept.length} directories`)
    })()
      .catch((err) => console.error('[archive] sweep failed', err))
      .finally(() => {
        sweeping = null
      }))
  const archiveTimer = setInterval(() => void runArchiveSweep(), 60 * 60_000)
  archiveTimer.unref()
  setOrchestrationRegistry(registry)
  setAppToolsRegistry(registry)
  void runDoctor() // warm the cache so the new-session modal opens ready
  void probeCatalogs() // the five probed harnesses ask their CLIs for models
  void startCodexTiers(store) // which service tiers the codex account has, per model
  void installedCodexVersion() // hides catalog rows the installed codex cannot run

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
  const remoteAuth = new RemoteAuth(db)
  // The fixed port behind the tunnel (remote/listener.ts). An env override
  // beats the settings so a dev instance never fights the installed app
  // for 7677; '0' turns it off.
  let remote: RemoteListener | null = null
  /** The port to listen on, or null for off: the option or the env var
   *  override the PORT (0 in the env turns it off); remote.enabled applies either way. */
  const remotePortWanted = (): number | null => {
    const settings = readRemoteSettings(store)
    if (!settings.enabled) return null
    if (options.remotePort !== undefined) return options.remotePort
    const env = process.env.TEMP_CODE_REMOTE_PORT
    if (env === undefined) return settings.port
    const n = Number(env)
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : null
  }
  let remoteRestart: Promise<void> = Promise.resolve()
  const restartRemote = (): Promise<void> =>
    (remoteRestart = remoteRestart.then(async () => {
      await remote?.close()
      remote = null
      const port = remotePortWanted()
      if (port === null) return
      remote = await startRemoteListener({
        port,
        auth: remoteAuth,
        store,
        environmentId,
        version: appVersion,
        build,
        // `host` makes the socket a relayed lane to that host (remote/relay.ts).
        attach: (ws, principal, host) => (host ? hostRelay.attachRelayed(ws, principal, host) : attach(ws, principal)),
        relayOnline: (id) => hostRelay.online(id),
        hosts: () => hostRelay.hosts(),
        mcp: createMcpHandler({
          auth: remoteAuth,
          registry,
          version: appVersion,
          origin: () => pairingOrigin(readRemoteSettings(store), remote?.port ?? 0),
          environmentId,
          hostName: hostname(),
          relay: hostRelay.facadeHosts()
        }),
        // The built renderer (electron-vite build); a dev tree without it answers 503.
        ui: createUiHandler({ rendererDir: join(options.appPath ?? process.cwd(), 'out', 'renderer'), assets: options.assets })
      })
    }))
  // The phones' push registrations forward to the hub (made below), or go
  // out from here when this host holds the APNs key (remote/apns.ts); a
  // revoked key takes its registration and activities with it.
  const apns = apnsFromEnv()
  const pushRegistry = new PushRegistry(db, {
    hub: () => hub,
    apns: () => apns,
    hostId: () => process.env.TEMP_CODE_HUB_HOST_ID || environmentId,
    environmentId: () => environmentId
  })
  remoteAuth.onRevoke((keyId) => void pushRegistry.dropKey(keyId))
  const remoteContext: RemoteContext = {
    environmentId,
    auth: remoteAuth,
    store,
    push: pushRegistry,
    status: () => ({ running: remote !== null && remote.port > 0, port: remote?.port ?? 0, error: remote?.error ?? null }),
    onSettingsChanged: () => void restartRemote()
  }

  // One loopback listener, two WebSocket servers: an upgrade routes by wire
  // profile (wire.ts profileFor) and only the remote server negotiates
  // permessage-deflate, so the local renderer's frames stay as they were.
  // A remote listener of its own should build its WebSocketServer with
  // remoteDeflateOptions() and call attach() with its principal.
  const httpServer = createServer((_req, res) => {
    res.statusCode = 426
    res.setHeader('Upgrade', 'websocket')
    res.end()
  })
  const wssLocal = new WebSocketServer({ noServer: true })
  const wssRemote = new WebSocketServer({ noServer: true, perMessageDeflate: remoteDeflateOptions() })
  const servers = [wssLocal, wssRemote]
  let connections = 0
  setBufferedBytes(() => {
    let most = 0
    for (const wss of servers) for (const client of wss.clients) most = Math.max(most, client.bufferedAmount)
    return most
  })

  /**
   * One socket speaking the contract. The local renderer's socket arrives
   * as LOCAL_PRINCIPAL; the remote listener (remote/listener.ts) calls this
   * with the key it authenticated. Every request is gated on the
   * principal's capabilities before any handler runs.
   */
  const attach = (ws: WebSocket, principal: Principal, profile: WireProfile = profileFor({ principal })): void => {
    const connection = ++connections
    const unsubs = new Map<string, () => void>()
    /** This socket carries `sessionId`'s rows from now on (once per socket). */
    const subscribeSocket = (sessionId: string): void => {
      // Opening a thread: its shown account is the one its next send uses.
      registry.refreshAccount(sessionId)
      if (unsubs.has(sessionId)) return
      unsubs.set(
        sessionId,
        registry.subscribe(sessionId, (row) => {
          countPush('event')
          emitPush({ push: 'event', row })
        })
      )
    }
    let unsubscribeAccounts: (() => void) | null = null
    // The Mac bridge's prompts go to this Mac's own sockets only, never a key's.
    const offMacBridge = principal.kind === 'local' ? macBridge.subscribe((push) => sendFrame(push)) : null
    // Master's release number, when it changes: this host's own sockets only.
    const localSink = principal.kind === 'local' ? (push: ServerPush): void => sendFrame(push) : null
    if (localSink) localSinks.add(localSink)
    // The relay's presence push: every remote client socket (a relayed lane's are the relay's own).
    const remoteSink = principal.kind === 'remote' ? (push: ServerPush): void => sendFrame(push) : null
    if (remoteSink) remoteSinks.add(remoteSink)
    /** The host-log subscriptions this socket asked for (hostJobs.ts). */
    const offHostLogs: (() => void)[] = []
    const offResources = resources.onChange((sessionId, list) => emitPush({ push: 'resources', sessionId, resources: list }))
    const onHeld = (push: MacHeldPush): void => sendFrame(push)
    heldListeners.add(onHeld)
    /** per-connection file watchers (fs.watch), keyed by projectId */
    const fsWatches = new Map<string, () => void>()
    // One line per connection the first time its unsent bytes pass the mark:
    // the client is not draining its socket, whatever the request log says.
    let backpressureLogged = false
    /** Closed: a bulk request of this socket still waiting in the lane gate is dropped. */
    let socketClosed = false
    const dropped = new Set<string>()
    const sendFrame = (frame: ServerFrame): void => {
      if (ws.readyState !== ws.OPEN) return
      if ('id' in frame && dropped.delete(frame.id)) {
        console.log(`[server] dropped the answer to ${frame.id} (TEMP_CODE_DROP_ANSWERS)`)
        return
      }
      ws.send(frameJson(frame))
      if (!backpressureLogged && ws.bufferedAmount > BACKPRESSURE_BYTES) {
        backpressureLogged = true
        recordBackpressure(connection, ws.bufferedAmount)
      }
    }
    // Every connection's pushes go through a coalescer (wire.ts): stored
    // event rows on a 33 ms window and metas (the newest per thread) and
    // builds on 100 ms, each sending the first of a quiet period at once;
    // partial tool calls (newest per call) and live edits on 100 ms with no
    // leading edge. A fleet once pushed 13k metas in a second, each its own
    // frame to every socket. Only the remote profile takes large bodies off;
    // the pieces' JSON is shared across sockets (frameJson). The thread this
    // socket looks at (session.focus) sends its rows at once; every other
    // thread's rows wait 100 ms (250 ms remote) while the loop lags.
    const coalescer = new PushCoalescer(sendFrame, undefined, undefined, {
      project: profile === 'remote',
      immediate: (sessionId) => focus.isFocusedBy(connection, sessionId),
      eventsDelay: () => eventsWindowMs(profile, currentLag().meanMs)
    })
    const emitPush = (frame: ServerPush): void => coalescer.push(frame)
    /** Project lookup that throws — fs/git methods are meaningless without one. */
    const mustProject = (projectId: string): { id: string; cwd: string } => {
      const project = registry.getProject(projectId)
      if (!project) throw new Error(`unknown project: ${projectId}`)
      return project
    }

    // Every client gets session-meta updates (cheap, drives the sidebar).
    const offMeta = registry.onMeta((session) => {
      countPush('meta')
      emitPush({ push: 'session', session })
    })
    // A thread's notes changed: every client follows (the panel, the rows).
    const offNotes = registry.notes.onChange((sessionId, doc) => emitPush({ push: 'notes', sessionId, doc }))
    // A master's batch moved a step, or one child's digest moved: the
    // sockets watching that master's board hear the delta (boardWatch.ts);
    // a socket that never asked for a board (the phone) gets the whole state.
    const offBatch = batchRuns.onChange((state, push) => {
      if (boardWatch.isWatching(connection, state.masterId)) emitPush({ push: 'batch-delta', state: push })
      else if (!boardWatch.asksBoards(connection)) emitPush({ push: 'batch', state })
    })
    const offBoard = boardDigests.onPush((p) => {
      if (boardWatch.isWatching(connection, p.masterId)) emitPush({ push: 'board', ...p })
    })
    const offCatalog = registry.onCatalog((kind) => emitPush(kind === 'workspaces'
      ? { push: 'workspaces', workspaces: registry.listWorkspaces() }
      : { push: 'projects', projects: registry.listProjects() }))
    // A live edit goes only to the sockets watching a thread that owns it
    // (the writer or its root, livediff.ts): every edit of a fleet went to
    // every socket, each with its diff.
    const offLive = onLiveEdit((p) => {
      if (p.sessionIds.some((id) => unsubs.has(id))) emitPush(p)
    })
    // A thread's checkpoint moved (a turn settled): only the sockets watching it.
    const onCheckpoint = (sessionId: string, push: ServerPush): void => {
      if (unsubs.has(sessionId)) emitPush(push)
    }
    checkpointSinks.add(onCheckpoint)
    const offBuild = builder.onPush((p) => emitPush(p))
    const offDevRuns = devRuns.onPush((p) => emitPush(p))
    // The picture moves with every answer's usage headers: this socket hears
    // the newest one at most every 5 s (accounts.ts accountsPusher).
    const accountsPush = accountsPusher((snapshot) => emitPush({ push: 'accounts', snapshot }))
    const offAccountsChange = m3a.accounts.onChange((snapshot) => accountsPush.offer(snapshot))
    const offAccounts = (): void => {
      offAccountsChange()
      accountsPush.dispose()
    }
    const offQueue = registry.onQueue((sessionId, items) =>
      emitPush({ push: 'queue', sessionId, items })
    )
    const offRemoved = registry.onRemoved((sessionIds) => {
      for (const id of sessionIds) {
        unsubs.get(id)?.()
        unsubs.delete(id)
      }
      emitPush({ push: 'session-removed', sessionIds })
    })
    // Ahead of its session-removed: clients re-point the thread instead of closing it.
    const offMoved = registry.onMoved((id, sessionIds, to) => emitPush({ push: 'session-moved', id, sessionIds, to }))
    sendFrame({
      push: 'hello',
      environmentId,
      contract: CONTRACT_VERSION,
      caps: principalCaps(principal),
      ...(principal.kind === 'remote' ? { key: { id: principal.keyId, name: principal.name } } : {}),
      build,
      // The hosts reachable through this one (remote/relay.ts), for a remote caller.
      ...(principal.kind === 'remote' && hostRelay.hosts().length > 0 ? { hosts: hostRelay.hosts() } : {})
    })
    // The boot's resume count: already known to a late socket, announced to an open one.
    if (bootResumer.notice) sendFrame({ push: 'boot-resume', ...bootResumer.notice })
    const offBootResume = bootResumer.onDone((notice) => sendFrame({ push: 'boot-resume', ...notice }))

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
      // `lane: 'ui'` rides beside the method (lane.ts); the schema strips it.
      const req: ClientRequest = (raw as { lane?: unknown }).lane === 'ui' ? Object.assign(parsed.data, { lane: 'ui' as const }) : parsed.data
      if (dropAnswer(req.method)) dropped.add(req.id)
      // TEMP_CODE_PEER_DELAY_MS (peerDelay.ts): a proof's slow box.
      if (PEER_DELAY_MS > 0) await peerDelay(principal.kind, PEER_DELAY_MS)
      if (principal.kind !== 'local') {
        const need = requiredCapability(req)
        if (need === 'local') return sendFrame({ id: req.id, ok: false, error: `forbidden: ${req.method} is local-only` })
        if (!allows(principal.caps, need)) return sendFrame({ id: req.id, ok: false, error: `forbidden: ${req.method} needs ${need}` })
      }
      const startedAt = Date.now()
      const requestKey = `${connection}:${req.id}`
      trackRequest(requestKey, req.method)
      try {
        // A remote key names paths only inside the app-managed roots; the
        // refusal is one typed error that never carries the path. Ahead of
        // the lane gate: a bulk request never joins one it may not make.
        if (principal.kind !== 'local') fenceRequest(req, managedRoots(), [ATTACH_DIR])
        // The lane gate (lane.ts): interactive and normal run now; bulk waits
        // its turn and a duplicate shares the answer of the one before it.
        const lane = laneOf(req, focus)
        if (lane === 'bulk') {
          // A read joins whoever asked first and runs even if this socket
          // closes (they want it); this socket's own request is dropped once
          // it closed (a watch must not register for a closed socket).
          const key = bulkKey(req)
          const answer = await laneGate.run(lane, key, () => (key === null && socketClosed ? Promise.resolve(null) : captureAnswer(req)))
          if (answer) sendFrame({ ...answer, id: req.id })
        } else await serve(req, sendFrame)
      } catch (err) {
        sendFrame({
          id: req.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        })
      } finally {
        // A request this slow held the main thread or waited behind
        // something that did; either way the boot log should say which.
        untrackRequest(requestKey)
        const ms = Date.now() - startedAt
        if (ms > SLOW_REQUEST_MS) {
          bootMark('slow-request', `${req.method} ${ms}ms`)
          recordSlowRequest(req.method, ms)
        }
      }
    })

    /** One request, answered through `sendFrame`: the socket's own, or a
     *  bulk request's capture (captureAnswer). Pushes a handler makes go to
     *  the socket either way. */
    const serve = async (req: ClientRequest, sendFrame: (frame: ServerFrame) => void): Promise<void> => {
      try {
        // A pull marks the socket as another host's main process: it hears
        // every later rotation (never a renderer, which never pulls).
        if (req.method === 'page.read') {
          const html = await readPage(req.params.sessionId, req.params.pageId)
          return sendFrame({ id: req.id, ok: true, result: { html } })
        }
        if (req.method === 'media.read') {
          const range = await readMediaRange(req.params.token, req.params.offset, req.params.length)
          return sendFrame({ id: req.id, ok: true, result: range })
        }
        if (req.method === 'accounts.pull') {
          const answer = await accountSync.handlePull(req.params.from, req.params)
          if (principal.kind === 'remote') unsubscribeAccounts ??= accountSync.subscribe(sendFrame)
          return sendFrame({ id: req.id, ok: true, result: answer })
        }
        // The reverse RPC (remote/peerCalls.ts): a Mac's main process registers
        // this socket and answers calls on it; then the bridge's own methods.
        if (req.method === 'peer.register' || req.method === 'peer.reply' || req.method === 'peer.chunk' || req.method === 'peer.progress') {
          const peerSocket = { connection, keyId: principal.kind === 'remote' ? principal.keyId : null, keyName: principal.kind === 'remote' ? principal.name : null, remote: principal.kind === 'remote', send: sendFrame, buffered: () => ws.bufferedAmount }
          return sendFrame({ id: req.id, ok: true, result: handlePeerRequest(peerCalls, peerSocket, req) })
        }
        // A Mac's side of a forwarded dev server (remote/portForward.ts), only from the socket it registered on.
        if (req.method === 'ports.bound' || req.method === 'ports.open' || req.method === 'ports.data' || req.method === 'ports.close') {
          if (principal.kind !== 'remote') throw new Error(`forbidden: ${req.method} is for another host's main process`)
          if (peerCalls.connectionOf(req.params.from) !== connection) throw new Error(`forbidden: ${req.params.from} is not registered on this socket`)
          const from = req.params.from
          switch (req.method) {
            case 'ports.bound':
              return sendFrame({ id: req.id, ok: true, result: portHost.bound(from, req.params.bound) })
            case 'ports.open':
              return sendFrame({ id: req.id, ok: true, result: await portHost.open(from, req.params.streamId, req.params.forwardId) })
            case 'ports.data':
              return sendFrame({ id: req.id, ok: true, result: portHost.data(from, req.params.streamId, req.params.seq, req.params.data) })
            case 'ports.close':
              return sendFrame({ id: req.id, ok: true, result: portHost.close(from, req.params.streamId, req.params.seq, req.params.error) })
          }
        }
        // This Mac's own forwards and their switch (Settings → Remote access).
        if (req.method === 'ports.forwards') return sendFrame({ id: req.id, ok: true, result: { hosts: macPorts.hosts() } })
        if (req.method === 'ports.setForwarding')
          return sendFrame({ id: req.id, ok: true, result: { hosts: await macPorts.setEnabled(req.params.environmentId, req.params.enabled) } })
        // A Mac pulling a staged mac.writeFile, only on the socket the call went out on (macWriteStage.ts).
        if (req.method === 'peer.pull')
          return sendFrame({ id: req.id, ok: true, result: handlePeerPull(macWriteStages, { connection, remote: principal.kind === 'remote' }, req.params) })
        // The relay (remote/relay.ts): a host's presence and its lanes' frames, each only
        // from the socket that host registered on.
        if (req.method === 'peer.presence' || req.method === 'relay.frames' || req.method === 'relay.closed' || req.method === 'relay.notice') {
          if (principal.kind !== 'remote') throw new Error(`forbidden: ${req.method} is for another host's main process`)
          if (peerCalls.connectionOf(req.params.from) !== connection) throw new Error(`forbidden: ${req.params.from} is not registered on this socket`)
          switch (req.method) {
            case 'peer.presence':
              peerCalls.touch(connection, req.params.presence)
              return sendFrame({ id: req.id, ok: true, result: hostRelay.onPeerPresence(req.params.from, req.params.presence) })
            case 'relay.frames':
              peerCalls.touch(connection)
              return sendFrame({ id: req.id, ok: true, result: hostRelay.onFrames(req.params.from, req.params.socketId, req.params.frames) })
            case 'relay.closed':
              return sendFrame({ id: req.id, ok: true, result: hostRelay.onClosed(req.params.from, req.params.socketId, req.params.reason) })
            case 'relay.notice':
              return sendFrame({ id: req.id, ok: true, result: hostRelay.onNotice(req.params.from, req.params.notice) })
          }
        }
        // A proof seam: this isolated instance's screen and power state (src/main/presence.ts).
        if (req.method === 'presence.set') {
          const set = (presence as { set?: (patch: { screen?: ScreenState; power?: PowerState }) => unknown }).set
          if (process.env.TEMP_CODE_E2E_PRESENCE !== '1' || !process.env.TEMP_CODE_USER_DATA || !set)
            throw new Error('presence.set is a proof seam (TEMP_CODE_E2E_PRESENCE=1 on an isolated instance)')
          return sendFrame({ id: req.id, ok: true, result: set.call(presence, req.params) })
        }
        // Another host reporting on a thread it runs for this one (remote/crossHostThreads.ts): a settle, or a batch landing.
        if (req.method === 'crossHost.settled' || req.method === 'crossHost.landing') {
          if (principal.kind !== 'remote') throw new Error(`forbidden: ${req.method} is for another host's main process`)
          const from = peerCalls.environmentOf(connection) ?? req.params.from
          return sendFrame({
            id: req.id,
            ok: true,
            result: req.method === 'crossHost.settled' ? crossHostAgents.settled(from, req.params) : crossHostAgents.landing(from, req.params)
          })
        }
        // Another host asking for a thread here (the Mac → the box): the thread.* methods as requests, the caller the socket's registration.
        if (req.method.startsWith('thread.')) {
          if (principal.kind !== 'remote') throw new Error(`forbidden: ${req.method} is for another host's main process`)
          const served = crossHostThreads.handleRequest(req.method, 'params' in req ? req.params : undefined, peerCalls.environmentOf(connection))
          if (served) return sendFrame({ id: req.id, ok: true, result: await served })
        }
        if (req.method === 'deploy.master') return sendFrame({ id: req.id, ok: true, result: masterRelease.current() })
        const planned = handleProjectPlan(req, projectPlans)
        if (planned.handled) return sendFrame({ id: req.id, ok: true, result: planned.result })
        if (req.method === 'batch.board') boardWatch.ask(connection, req.params.masterId)
        const batched = await handleBatch(req, batchRuns, registry, boardDigests)
        if (batched.handled) return sendFrame({ id: req.id, ok: true, result: batched.result })
        const macBridged = handleMacBridge(req, macBridge)
        if (macBridged.handled) return sendFrame({ id: req.id, ok: true, result: macBridged.result })
        const devices = await handleHostDevices(req, hostDevices, { connection, send: sendFrame })
        if (devices.handled) return sendFrame({ id: req.id, ok: true, result: devices.result })
        const macTooled = await macTools.handle(req)
        if (macTooled.handled) return sendFrame({ id: req.id, ok: true, result: macTooled.result })
        const remote = await handleRemote(
          req,
          principal.kind === 'local' ? remoteContext : { ...remoteContext, ceiling: principal.caps, createdBy: principal.keyId }
        )
        if (remote.handled) {
          if (req.method.startsWith('remote.environments.')) peers.refresh()
          return sendFrame({ id: req.id, ok: true, result: remote.result })
        }
        const harness = await handleHarness(req, harnessSync)
        if (harness.handled) return sendFrame({ id: req.id, ok: true, result: harness.result })
        const host = await handleHost(req, hostJobs, { connection, send: sendFrame, onClose: (off) => offHostLogs.push(off) })
        if (host.handled) return sendFrame({ id: req.id, ok: true, result: host.result })
        const memory = await handleMemory(req, memorySync)
        if (memory.handled) return sendFrame({ id: req.id, ok: true, result: memory.result })
        const upload = await handleAttachmentUploads(req, uploads, principal.kind === 'remote' ? `key:${principal.keyId}` : principal.kind)
        if (upload.handled) return sendFrame({ id: req.id, ok: true, result: upload.result })
        const moved = await handleSessionMove(req, sessionMover)
        if (moved.handled) return sendFrame({ id: req.id, ok: true, result: moved.result })
        const extension = await handleM3a(req, m3a)
        if (extension.handled) { sendFrame({ id: req.id, ok: true, result: extension.result }); return }
        const fsGit = await handleFsGit(req)
        if (fsGit.handled) return sendFrame({ id: req.id, ok: true, result: fsGit.result })
        const checkpoint = await handleCheckpoint(req, checkpointTurns)
        if (checkpoint.handled) return sendFrame({ id: req.id, ok: true, result: checkpoint.result })
        const lin = await handleLinear(req, linear)
        if (lin.handled) return sendFrame({ id: req.id, ok: true, result: lin.result })
        const gh = await handleGithubInbox(req, githubInbox)
        if (gh.handled) return sendFrame({ id: req.id, ok: true, result: gh.result })
        switch (req.method) {
          case 'catalog.get':
            if (req.params?.refresh) {
              forgetCodexVersion()
              await Promise.all([probeCatalogs(true), probeCodexTiers(store), installedCodexVersion()])
            } else await Promise.all([codexTiersReady(), installedCodexVersion()])
            sendFrame({ id: req.id, ok: true, result: visibleCatalog() })
            break
          case 'doctor.get':
            sendFrame({
              id: req.id,
              ok: true,
              result: {
                ...(await runDoctor()),
                java: await javaDoctor(),
                loop: currentLag(),
                inFlight: inFlightRequests(),
                gateway: { ...gateway.status().process, port: gateway.status().port }
              } satisfies DoctorGetResult
            })
            break
          case 'doctor.profile':
            sendFrame({ id: req.id, ok: true, result: await profileHost(req.params) })
            break
          case 'providers.update': {
            const updated = await updateProvider(req.params.provider)
            if (req.params.provider === 'codex') {
              forgetCodexVersion()
              await installedCodexVersion()
            }
            sendFrame({ id: req.id, ok: true, result: updated })
            break
          }
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
          case 'workspace.root':
            sendFrame({ id: req.id, ok: true, result: workRoot(store) })
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
            if (!(await projectSettings.forward(req.params.projectId, req.method, req.params)))
              registry.renameProject(req.params.projectId, req.params.name)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'project.setAccounts':
            if (!(await projectSettings.forward(req.params.projectId, req.method, req.params)))
              registry.setProjectAccounts(req.params.projectId, req.params.pins)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'workspace.setAccounts':
            registry.setWorkspaceAccounts(req.params.workspaceId, req.params.pins)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'project.setPreamble':
            if (!(await projectSettings.forward(req.params.projectId, req.method, req.params)))
              registry.setProjectPreamble(req.params.projectId, req.params.preamble, req.params.enabled)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'workspace.setPreamble':
            registry.setWorkspacePreamble(req.params.workspaceId, req.params.preamble, req.params.enabled)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'catalog.link':
            registry.linkCatalog(req.params)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'project.ensureLinked':
            sendFrame({ id: req.id, ok: true, result: await ensureLinked(linkedCopies, req.params) })
            break
          case 'project.settings.get':
            sendFrame({ id: req.id, ok: true, result: registry.getProjectSettings(req.params.projectId) })
            break
          case 'project.settings.set':
            if (!(await projectSettings.forward(req.params.projectId, req.method, req.params)))
              registry.setProjectSettings(req.params.projectId, req.params.bundle)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.setMaster':
            registry.setMaster(req.params.sessionId, req.params.master)
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
          case 'project.archive': {
            // The cleanup is this host's checkout: the home gets the flag alone.
            const { cleanup, ...flag } = req.params
            if (await projectSettings.forward(req.params.projectId, req.method, flag)) {
              if (req.params.archived && cleanup) await registry.cleanupProjectGit(req.params.projectId, cleanup)
            } else await registry.archiveProject(req.params.projectId, req.params.archived, cleanup)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          }
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
                  emitPush({ push: 'file-event', ...e })
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
            const merged = await mergeInto(project.cwd, req.params.target)
            // A build landing on the project's branch ticks the milestone
            // its thread works in the project plan.
            if (merged.ok) projectPlans.landed(project.id)
            sendFrame({ id: req.id, ok: true, result: merged })
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
            if (!(await rulesSync.forward(req.method, req.params.workspaceId, req.params.rules)))
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
            if (!(await rulesSync.forward(req.method, req.params.workspaceId, req.params.defaults)))
              registry.setThreadDefaults(req.params.workspaceId, req.params.defaults)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'plans.get': {
            const scoped = registry.getPlanSettings(req.params.projectId)
            sendFrame({
              id: req.id,
              ok: true,
              result: {
                settings:
                  scoped ??
                  (req.params.projectId ? registry.getPlanSettings(null) : null) ??
                  DEFAULT_PLAN_SETTINGS,
                overridden: scoped !== null
              } satisfies PlanScope
            })
            break
          }
          case 'plans.set':
            if (!(await projectSettings.forward(req.params.projectId, req.method, req.params)))
              registry.setPlanSettings(req.params.projectId, req.params.settings)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.start':
            sendFrame({ id: req.id, ok: true, result: { started: await registry.startQueued(req.params.sessionId) } })
            break
          case 'plan.implement': {
            const { sessionId, ...opts } = req.params
            sendFrame({ id: req.id, ok: true, result: await registry.implementPlan(sessionId, opts) })
            break
          }
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
            if (!req.params.projectId) registry.setTurnPass(req.params.workspaceId, req.params.pass)
            else if (!(await projectSettings.forward(req.params.projectId, req.method, req.params)))
              registry.setProjectTurnPass(req.params.projectId, req.params.pass)
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
            if (!req.params.projectId) registry.setBuild(req.params.workspaceId, req.params.config)
            else if (!(await projectSettings.forward(req.params.projectId, req.method, req.params)))
              registry.setProjectBuild(req.params.projectId, req.params.config)
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
                emitPush({ push: 'sync', projectId: project.id, branch, ...p })
              )
            })
            break
          }
          case 'devServer.targets':
            sendFrame({ id: req.id, ok: true, result: await devRuns.targets(req.params.projectId) })
            break
          case 'devServer.runs':
            sendFrame({ id: req.id, ok: true, result: { runs: devRuns.running() } })
            break
          case 'devServer.start':
            sendFrame({ id: req.id, ok: true, result: { run: await devRuns.start(req.params.projectId, req.params.targetId) } })
            break
          case 'devServer.stop':
            sendFrame({ id: req.id, ok: true, result: { run: await devRuns.stop(req.params.runId) } })
            break
          case 'devServer.restart':
            sendFrame({ id: req.id, ok: true, result: { run: await devRuns.restart(req.params.runId) } })
            break
          case 'devServer.log':
            sendFrame({ id: req.id, ok: true, result: devRuns.history(req.params.runId) })
            break
          case 'devServer.portLog':
            sendFrame({ id: req.id, ok: true, result: await portLogs.read(req.params.resourceId, req.params.from) })
            break
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
          case 'review.get': {
            const projectId = req.params.projectId
            sendFrame({
              id: req.id,
              ok: true,
              result: {
                override: projectId ? registry.getReviewSettings(projectId) : null,
                global: registry.getReviewSettings(null),
                ...registry.effectiveReview(projectId)
              } satisfies ReviewScope
            })
            break
          }
          case 'review.set':
            if (!(await projectSettings.forward(req.params.projectId, req.method, req.params)))
              registry.setReviewSettings(req.params.projectId, req.params.settings)
            sendFrame({ id: req.id, ok: true, result: null })
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
              result: await readAttachment(req.params.path, managedRoots())
            })
            break
          case 'session.create': {
            const session = await registry.create(req.params)
            sendFrame({ id: req.id, ok: true, result: session })
            break
          }
          case 'stall.report':
            reportRendererStall(req.params.line)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.list': {
            const sessions = registry.list({
              archived: req.params?.archived ?? false,
              projectId: req.params?.projectId
            })
            if (!firstListMarked) {
              firstListMarked = true
              bootMark('first-session-list', `${sessions.length} sessions`)
            }
            const result = profile === 'remote' ? sessionPage(sessions, req.params?.cursor) : sessions
            const frame = timed('session.list stringify', () =>
              JSON.stringify({ id: req.id, ok: true, result } satisfies ServerFrame)
            )
            if (ws.readyState === ws.OPEN) ws.send(frame)
            break
          }
          case 'session.changes': {
            const changes = listChanges.since(req.params.afterSeq, req.params.generation)
            if (changes.reset) {
              const result: SessionChanges = { reset: true, seq: changes.seq, generation: changes.generation }
              sendFrame({ id: req.id, ok: true, result })
              break
            }
            const sessions: SessionMeta[] = []
            const removed = [...changes.removed]
            for (const id of changes.changed) {
              const meta = registry.get(id)
              if (meta) sessions.push(meta)
              else removed.push(id)
            }
            const result: SessionChanges = { reset: false, seq: changes.seq, generation: changes.generation, sessions, removed }
            sendFrame({ id: req.id, ok: true, result })
            break
          }
          case 'session.events': {
            // The listener goes on before the read: a row appended after it
            // is pushed, one before it is in the page (the client drops a
            // seq it already folded).
            if (req.params.subscribe) subscribeSocket(req.params.sessionId)
            if (profile === 'remote') {
              const page = eventsPage(registry, req.params)
              sendFrame({ id: req.id, ok: true, result: req.params.subscribe ? { ...page, subscribed: true } : page })
            } else sendFrame({ id: req.id, ok: true, result: registry.events(req.params.sessionId, req.params) })
            break
          }
          case 'session.rowBody': {
            const row = registry.eventAt(req.params.sessionId, req.params.seq)
            if (row) sendFrame({ id: req.id, ok: true, result: { row } })
            else sendFrame({ id: req.id, ok: false, error: `no row ${req.params.seq} in session ${req.params.sessionId}` })
            break
          }
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
          case 'harness.warm': {
            if (req.params?.retire) retireWarmPools()
            sendFrame({ id: req.id, ok: true, result: warmStatuses() })
            break
          }
          case 'session.preconnect':
            sendFrame({ id: req.id, ok: true, result: registry.preconnectIdle(req.params.sessionId) })
            break
          case 'session.focus':
            focus.set(connection, req.params.sessionId)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.interrupt':
            // Its Mac work first: the calls out on the Mac and its jobs end, what a pause held is refused.
            macTools.pause.stop(req.params.sessionId)
            await registry.stopRun(req.params.sessionId)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.pause':
            await registry.pauseRun(req.params.sessionId)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.resume':
            // A stopped thread (its harness gone) gets a fresh one on its
            // transcript; a paused tree continues as before.
            if (registry.get(req.params.sessionId)?.status === 'stopped') {
              await registry.resumeStopped(req.params.sessionId)
            } else {
              await registry.resumePausedRun(req.params.sessionId)
            }
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.markStatus': {
            // A proof's seam only (scripts/e2e-mac-bridge.ts): a status without a harness, on an isolated instance.
            if (process.env.TEMP_CODE_E2E_STATUS !== '1' || !process.env.TEMP_CODE_USER_DATA)
              throw new Error('session.markStatus is a proof seam (TEMP_CODE_E2E_STATUS=1 on an isolated instance)')
            registry.markStatusForProof(req.params.sessionId, req.params.status)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          }
          case 'session.proofShellCall': {
            // A proof's seam only (scripts/e2e-port-forward.ts): a shell call's rows on an isolated instance.
            if (process.env.TEMP_CODE_E2E_STATUS !== '1' || !process.env.TEMP_CODE_USER_DATA)
              throw new Error('session.proofShellCall is a proof seam (TEMP_CODE_E2E_STATUS=1 on an isolated instance)')
            const { sessionId, callId, command, output } = req.params
            if (!registry.get(sessionId)) throw new Error(`unknown session: ${sessionId}`)
            registry.append(sessionId, { type: 'tool-call', callId, name: 'Bash', input: { command } })
            registry.append(sessionId, { type: 'tool-result', callId, output, isError: false })
            sendFrame({ id: req.id, ok: true, result: null })
            break
          }
          case 'session.continueAllErrors':
            sendFrame({ id: req.id, ok: true, result: await registry.continueAllErrors() })
            break
          case 'session.pauseAllRunning':
            sendFrame({ id: req.id, ok: true, result: await registry.pauseAllRunning() })
            break
          case 'session.resumeAllPaused':
            sendFrame({ id: req.id, ok: true, result: await registry.resumeAllPaused() })
            break
          case 'session.batch':
            sendFrame({
              id: req.id,
              ok: true,
              result: await registry.batch(req.params.action, req.params.ids, {
                cleanup: req.params.cleanup
              })
            })
            break
          case 'session.subscribe':
            subscribeSocket(req.params.sessionId)
            sendFrame({ id: req.id, ok: true, result: null })
            break
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
          case 'session.notes.get': {
            if (!registry.get(req.params.sessionId)) throw new Error(`unknown session: ${req.params.sessionId}`)
            sendFrame({ id: req.id, ok: true, result: registry.notes.read(req.params.sessionId) })
            break
          }
          case 'session.notes.set': {
            if (!registry.get(req.params.sessionId)) throw new Error(`unknown session: ${req.params.sessionId}`)
            sendFrame({ id: req.id, ok: true, result: registry.notes.write(req.params.sessionId, req.params.text) })
            break
          }
          case 'app.updateNotes': {
            const caller = registry.get(req.params.sessionId)
            if (!caller) throw new Error(`unknown session: ${req.params.sessionId}`)
            sendFrame({ id: req.id, ok: true, result: appUpdateNotes(registry, caller, req.params) })
            break
          }
          case 'session.archive':
            await registry.setArchived(req.params.sessionId, req.params.archived)
            // The thread's resources go after the archive lands; the rows and the
            // `resources` push carry each outcome (a Mac prompt may take a while).
            if (req.params.archived && req.params.removeResources) void resources.remove(req.params.sessionId)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'resources.list':
            sendFrame({ id: req.id, ok: true, result: { resources: resources.list(resources.ownerOf(req.params.sessionId), req.params.includeRemoved ?? false) } })
            break
          case 'admission.get':
            sendFrame({ id: req.id, ok: true, result: admission.state() })
            break
          case 'admission.set':
            sendFrame({ id: req.id, ok: true, result: admission.set(req.params.cap) })
            break
          case 'resources.listAll':
            sendFrame({ id: req.id, ok: true, result: { resources: resources.listAll(req.params ?? {}) } })
            break
          case 'resources.remove':
            sendFrame({ id: req.id, ok: true, result: { results: await resources.remove(req.params.sessionId, req.params.ids) } })
            break
          case 'session.delete':
            await registry.delete(req.params.sessionId)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.restart':
            await registry.restart(req.params.sessionId)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.reroute':
            sendFrame({ id: req.id, ok: true, result: await registry.reroute(req.params.sessionId) })
            break
          case 'session.continue': {
            const { sessionId, provider, model, reasoning } = req.params
            await registry.continueRun(
              sessionId,
              undefined,
              provider || model || reasoning ? { provider, model, reasoning } : undefined
            )
            sendFrame({ id: req.id, ok: true, result: null })
            break
          }
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
          case 'session.compact':
            await registry.compact(req.params.sessionId)
            sendFrame({ id: req.id, ok: true, result: null })
            break
          case 'session.killBackground':
            await registry.killBackground(req.params.sessionId)
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
              result: await appReadThread(registry, req.params.threadId, caller)
            })
            break
          }
          case 'app.planComplete': {
            const caller = callerOf(registry, req.params.sessionId)
            // A project plan completes into its file; an ordinary plan into the plan flow.
            sendFrame({
              id: req.id,
              ok: true,
              result:
                caller.threadType === 'project-plan'
                  ? projectPlans.complete(caller.id)
                  : await registry.completePlan(caller.id, req.params)
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
          // Agent HTML pages: errors go back as the frame's error string,
          // which the bridge hands the model as an isError tool result.
          case 'app.htmlPreview': {
            callerOf(registry, req.params.sessionId)
            sendFrame({ id: req.id, ok: true, result: await appHtmlPreview(req.params) })
            break
          }
          case 'app.htmlRender': {
            const caller = callerOf(registry, req.params.sessionId)
            sendFrame({ id: req.id, ok: true, result: await appHtmlRender(caller.id, req.params) })
            break
          }
          // Citations: the registry refuses outside a research tree (the
          // bridge's tool table is static, so codex chats reach this too).
          case 'app.citeSource': {
            const caller = callerOf(registry, req.params.sessionId)
            sendFrame({ id: req.id, ok: true, result: registry.citeSource(caller.id, req.params) })
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
              result: await orchCheckAgent(callerOf(registry, req.params.sessionId), req.params.agentId)
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
              result: await orchListAgents(callerOf(registry, req.params.sessionId))
            })
            break
          case 'app.mergeBranch': {
            const reviews = mergeReviews()
            const { sessionId, ...args } = req.params
            sendFrame({
              id: req.id,
              ok: true,
              result: reviews ? await reviews.mergeBranch(callerOf(registry, sessionId), args) : 'refused: merge reviews are not available here'
            })
            break
          }
          case 'app.reportFindings': {
            const reviews = mergeReviews()
            const { sessionId, ...report } = req.params
            sendFrame({
              id: req.id,
              ok: true,
              result: reviews ? reviews.reportFindings(callerOf(registry, sessionId), report) : 'refused: merge reviews are not available here'
            })
            break
          }
          case 'app.batchGate': {
            const { sessionId, ...args } = req.params
            sendFrame({ id: req.id, ok: true, result: await batchRuns.gate(callerOf(registry, sessionId), args) })
            break
          }
          case 'app.batchRules': {
            sendFrame({ id: req.id, ok: true, result: batchRuns.rulesTool(callerOf(registry, req.params.sessionId), req.params.rules ?? {}) })
            break
          }
          case 'app.adoptThread': {
            sendFrame({ id: req.id, ok: true, result: await batchRuns.adoptTool(callerOf(registry, req.params.sessionId), { threadId: req.params.threadId }) })
            break
          }
          case 'review.override': {
            const reviews = mergeReviews()
            if (!reviews) throw new Error('merge reviews are not available here')
            sendFrame({ id: req.id, ok: true, result: await reviews.override(req.params.sessionId, req.params.runId) })
            break
          }
        }
      } catch (err) {
        sendFrame({
          id: req.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    /** A bulk request's answer frame, kept for every request that joined it
     *  (lane.ts); null when the handler finished without one, so the slot
     *  frees. An answer later than that still reaches this socket. */
    const captureAnswer = (req: ClientRequest): Promise<ServerResponse | null> =>
      new Promise((resolve) => {
        let settled = false
        const capture = (frame: ServerFrame): void => {
          if ('push' in frame || frame.id !== req.id) return sendFrame(frame)
          if (settled) return sendFrame(frame)
          settled = true
          resolve(frame)
        }
        void serve(req, capture).finally(() => {
          if (settled) return
          settled = true
          resolve(null)
        })
      })

    ws.on('close', () => {
      socketClosed = true
      coalescer.dispose()
      focus.drop(connection)
      offBootResume()
      offMeta()
      offNotes()
      offBatch()
      offBoard()
      boardWatch.drop(connection)
      offCatalog()
      offQueue()
      offLive()
      checkpointSinks.delete(onCheckpoint)
      offBuild()
      offDevRuns()
      offAccounts()
      offRemoved()
      offMoved()
      unsubscribeAccounts?.()
      offMacBridge?.()
      if (localSink) localSinks.delete(localSink)
      if (remoteSink) remoteSinks.delete(remoteSink)
      for (const off of offHostLogs) off()
      offResources()
      heldListeners.delete(onHeld)
      peerCalls.drop(connection)
      hostDevices.dropConnection(connection)
      for (const off of unsubs.values()) off()
      unsubs.clear()
      for (const off of fsWatches.values()) off()
      fsWatches.clear()
    })
  }

  httpServer.on('upgrade', (req, socket, head) => {
    // LSP tunnel (docs/PLAN-3.md M13): raw JSON-RPC, no contract schema in
    // the hot path. Same localhost-only single-user trust as everything
    // else; the serverId is validated against the pool.
    const url = req.url ?? ''
    if (url.startsWith('/lsp/') || url.startsWith('/dap/')) {
      wssLocal.handleUpgrade(req, socket, head, (ws) => {
        if (url.startsWith('/lsp/')) attachLspSocket(url.slice('/lsp/'.length), ws)
        else attachDapSocket(url.slice('/dap/'.length), ws)
      })
      return
    }
    const profile = profileFor({ principal: LOCAL_PRINCIPAL, url })
    const wss = profile === 'remote' ? wssRemote : wssLocal
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, LOCAL_PRINCIPAL, profile))
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () => resolve())
  })
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await restartRemote()
  // Servers and gateway up: the threads cut by the last shutdown resume now.
  // Queued threads (scheduler.ts) start only once that resume is done, so a
  // restart never starts a queued batch on top of the resumed turns.
  const bootResume = bootResumer.run().catch((error) => console.error('[resume] boot resume failed:', error))
  registry.scheduler.holdUntil(bootResume)
  // A batch's deploy that restarted this process: closed from the trigger's files, then `then` (batch.ts).
  void bootResume.then(() => batchRuns.resumeAfterBoot()).catch((err) => console.log(`[batch] resume: ${err instanceof Error ? err.message : String(err)}`))

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

  // The hub names this host by its environment id: what a phone's saved host is keyed by (thread L6).
  const hub = hubFromEnv({ environmentId, name: hostname(), version: appVersion })
  // Thread transitions → the hub, each key's own webhook, and in-process
  // listeners (remote/notifier.ts). The hub's host id names this host in
  // both payloads so a receiver sees one id whichever way a notice came.
  const notifier = new Notifier({
    registry,
    stuckMinutes: () => readRemoteSettings(store).stuckMinutes,
    origin: () => pairingOrigin(readRemoteSettings(store), remote?.port ?? 0),
    // The notification's subtitle: the project's name, else the workspace's.
    place: (meta) =>
      (meta.projectId ? registry.getProject(meta.projectId)?.name : null) ??
      (meta.workspaceId ? registry.listWorkspaces().find((w) => w.id === meta.workspaceId)?.name : null) ??
      null,
    // The payload's tc.host: the phone adds it to the subtitle when several hosts are paired.
    hostName: () => hostname()
  })
  if (hub) {
    notifier.onNotice(
      (n) =>
        void hub.notify({ event: n.event, threadId: n.threadId, title: n.title, subtitle: n.subtitle, body: n.body, url: n.url, ts: n.ts, seq: n.seq, kind: n.kind, requestId: n.requestId, hostName: n.hostName })
    )
  }
  // A host with the key posts every notice to its phones itself.
  if (apns)
    notifier.onNotice((n) =>
      pushRegistry.deliver({ event: n.event, threadId: n.threadId, seq: n.seq, title: n.title, subtitle: n.subtitle, body: n.body, kind: n.kind, requestId: n.requestId, hostName: n.hostName, ts: n.ts }).then(() => undefined)
    )
  // Threads with a Live Activity on a phone: every change of what the card
  // shows goes out as a liveactivity push (coalesced for the task line), and
  // a needs-you notice gives the waiting state its reason; a watching
  // master's card counts its batch's children and names the engine's step,
  // re-read whenever the batch moves; registrations the hub never took are
  // offered again.
  const activityFeed = new ActivityFeed({
    registry,
    push: pushRegistry,
    hub: () => hub,
    local: () => apns !== null,
    isMaster: (m) => m.isMaster === true,
    batch: (id) => {
      const kids = batchChildren(registry, id)
      if (!kids.length) return null
      const running = batchRuns.get(id).steps.find((s) => s.status === 'running')
      const done = kids.filter((k) => k.status === 'done' || (k.status === 'idle' && registry.hasCompletedTurn(k.id))).length
      return { done, total: kids.length, step: running?.name ?? null }
    }
  })
  activityFeed.start()
  batchRuns.onChange((state) => activityFeed.poke(state.masterId))
  notifier.onNotice((n) => {
    if (n.event === 'needs_you') activityFeed.needsYou(n.threadId, n.body)
  })
  void pushRegistry.resync()
  notifier.onNotice((n) => {
    const targets = remoteAuth.webhookTargets(n.event)
    if (targets.length === 0) return
    return deliverWebhooks(targets, webhookPayload(n, process.env.TEMP_CODE_HUB_HOST_ID || environmentId)).then(() => undefined)
  })
  // A host with no delivery of its own sends its notices through the hosts it links to (remote/relayServe.ts).
  notifier.onNotice((n) => relayServer.onNotice(n))
  notifier.start()

  return {
    port,
    environmentId,
    accountSync,
    projectLinker,
    launchMirror,
    relay: hostRelay,
    relayServer,
    presence,
    remotePage: async (host, sessionId, pageId) => {
      const link = peers.get(host)
      if (!link) throw new Error('no link to that host')
      const { html } = await link.request<{ html: string | null }>('page.read', { sessionId, pageId })
      return html
    },
    remoteMedia: (host, token, offset, length) => {
      const link = peers.get(host)
      if (!link) throw new Error('no link to that host')
      return link.request<MediaRange | null>('media.read', { token, offset, length }, { timeoutMs: 60_000 })
    },
    attach,
    isInteractive: (sessionId) => focus.isInteractive(sessionId),
    remoteAuth,
    get remote() {
      return remote
    },
    hub,
    notifier,
    registry,
    store,
    gateway,
    accounts: m3a.accounts,
    notes: m3a.notes,
    build,
    masterRelease,
    batches: batchRuns,
    resources,
    hostDevices,
    projectPlans,
    macBridge,
    close: async () => {
      masterRelease.stop()
      notifier.stop()
      activityFeed.stop()
      apns?.close()
      hub?.stop()
      await remoteRestart
      await remote?.close()
      stopStallMonitor()
      laneGate.dispose()
      clearTimeout(warmKickoff)
      clearInterval(warmTimer)
      builder.disposeAll()
      devRuns.disposeAll()
      await gateway.stop()
      clearInterval(syncTimer)
      accountSync.close()
      harnessSync.close()
      hostJobs.deploy.dispose()
      hostJobs.publish.dispose()
      memorySync.close()
      projectLinker.close()
      projectSettings.close()
      rulesSync.close()
      uploads.close()
      sessionMover.close()
      relayServer.close()
      hostRelay.close()
      macBridge.close()
      macPorts.shutdown()
      portHost.shutdown()
      threadPorts.close()
      portSweep.close()
      crossHostThreads.close()
      hostDevices.close()
      peerCalls.close()
      peers.close()
      m3a.accounts.stop()
      if (headroomRows) clearTimeout(headroomRows)
      headroom.flush()
      admission.stop()
      await registry.disposeAll()
      offCheckpointEdits()
      closeWarmPools()
      await closeAllWatchers()
      await closeAllLiveWatchers()
      stopAllLsp()
      stopAllDap()
      killTrackedChildren()
      for (const wss of servers) for (const client of wss.clients) client.terminate()
      for (const wss of servers) {
        await new Promise<void>((resolve, reject) => wss.close((error) => (error ? reject(error) : resolve())))
      }
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
      // Workers go first: the writer's close() runs the last checkpoint and
      // deletes the WAL only when it is the last connection.
      await reader.stop()
      await checkpointWorker.stop()
      store.flushEvents()
      db.close()
    }
  }
}
