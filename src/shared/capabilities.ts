import type { ClientRequest } from './contract'

/**
 * What a remote caller may do. `read` is implied for every key; `admin`
 * implies everything. A method marked `local` never runs for a remote
 * connection at all: the loopback socket the desktop renderer uses is the
 * only caller that gets it (src/main/server/index.ts `LOCAL_PRINCIPAL`).
 */
export type Capability = 'read' | 'operate' | 'approve' | 'admin'
export const CAPABILITIES: readonly Capability[] = ['read', 'operate', 'approve', 'admin']
export type MethodCapability = Capability | 'local'

/** Bumped by hand when a client must know the contract moved under it. */
export const CONTRACT_VERSION = 1

/** Every contract method and the capability it needs. A new method without
 *  a row fails typecheck, so nothing reaches a remote caller ungated. */
export const METHOD_CAPABILITY: Record<ClientRequest['method'], MethodCapability> = {
  // local-only: the codex bridge's caller-claimed sessionId and host-process
  // plumbing never come over the tunnel.
  'app.listThreads': 'local',
  'app.readThread': 'local',
  'app.startThread': 'local',
  'app.planComplete': 'local',
  'app.htmlPreview': 'local',
  'app.htmlRender': 'local',
  'app.citeSource': 'local',
  'app.spawnAgent': 'local',
  'app.sendToAgent': 'local',
  'app.checkAgent': 'local',
  'app.waitForAgent': 'local',
  'app.answerAgent': 'local',
  'app.interruptAgent': 'local',
  'app.listAgents': 'local',
  'app.updateNotes': 'local',
  'stall.report': 'local',
  'dap.connect': 'local',
  'lsp.ensure': 'local',
  'lsp.status': 'local',
  'idea.eula': 'local',
  'idea.acceptEula': 'local',
  'idea.checkUpdate': 'local',
  'providers.update': 'local',
  'fim.complete': 'local',

  // read
  'catalog.get': 'read',
  'doctor.get': 'read',
  'workspace.list': 'read',
  'workspace.root': 'read',
  'workspace.icon': 'read',
  'workspace.getSnapshot': 'read',
  'project.list': 'read',
  'project.changes': 'read',
  'project.diff': 'read',
  'project.files': 'read',
  'project.log': 'read',
  'project.branches': 'read',
  'project.show': 'read',
  'project.compare': 'read',
  'project.blame': 'read',
  'file.read': 'read',
  'fs.list': 'read',
  'fs.read': 'read',
  'fs.watch': 'read',
  'fs.inspectPaths': 'read',
  'fs.listPath': 'read',
  'fs.media': 'read',
  'fs.projectFiles': 'read',
  'fs.readBase64': 'read',
  'fs.readPreview': 'read',
  'fs.readText': 'read',
  'fs.statFiles': 'read',
  'fs.digest': 'read',
  'git.branches': 'read',
  'git.diffIndex': 'read',
  'git.diffStats': 'read',
  'git.fileDiff': 'read',
  'git.fileMedia': 'read',
  'git.log': 'read',
  'git.rangeContext': 'read',
  'git.stagedContext': 'read',
  'github.details': 'read',
  'github.prDiff': 'read',
  'github.prStatus': 'read',
  'github.thread': 'read',
  'github.inbox': 'read',
  'checkpoint.status': 'read',
  'linear.status': 'read',
  'linear.teams': 'read',
  'linear.issues': 'read',
  'linear.details': 'read',
  'linear.thread': 'read',
  'build.get': 'read',
  'build.effective': 'read',
  'build.targets': 'read',
  'build.remote': 'read',
  'build.detect': 'read',
  'build.status': 'read',
  'rules.get': 'read',
  'plans.get': 'read',
  'defaults.get': 'read',
  'turnpass.get': 'read',
  'appshots.get': 'read',
  'commands.list': 'read',
  'attachment.read': 'read',
  'accounts.list': 'read',
  'notes.get': 'read',
  'notes.list': 'read',
  'notes.search': 'read',
  'search.project': 'read',
  'session.search': 'read',
  'session.list': 'read',
  'session.events': 'read',
  'session.rowBody': 'read',
  'session.subscribe': 'read',
  'session.unsubscribe': 'read',
  'session.context': 'read',
  'queue.list': 'read',

  // operate
  'workspace.create': 'operate',
  'workspace.delete': 'operate',
  'workspace.setSnapshot': 'operate',
  'project.create': 'operate',
  'project.rename': 'operate',
  'project.setBranch': 'operate',
  'project.archive': 'operate',
  'project.delete': 'operate',
  'project.commit': 'operate',
  'project.push': 'operate',
  'project.mergeFrom': 'operate',
  'project.mergeInto': 'operate',
  'fs.write': 'operate',
  'fs.create': 'operate',
  'fs.rename': 'operate',
  'fs.delete': 'operate',
  'fs.copyPath': 'operate',
  'fs.createPath': 'operate',
  'fs.deletePath': 'operate',
  'fs.movePath': 'operate',
  'fs.renamePath': 'operate',
  'fs.writeText': 'operate',
  'git.checkout': 'operate',
  'git.clone': 'operate',
  'git.commitStaged': 'operate',
  'git.createBranch': 'operate',
  'git.discardFile': 'operate',
  'git.pull': 'operate',
  'git.push': 'operate',
  'git.stageAll': 'operate',
  'git.stageContents': 'operate',
  'git.stageFile': 'operate',
  'git.stash': 'operate',
  'git.sync': 'operate',
  'git.unstageAll': 'operate',
  'git.unstageFile': 'operate',
  'github.comment': 'operate',
  'github.createPr': 'operate',
  'github.inboxRefresh': 'operate',
  'checkpoint.capture': 'operate',
  'checkpoint.ensure': 'operate',
  'checkpoint.keep': 'operate',
  'checkpoint.sync': 'operate',
  'checkpoint.undo': 'operate',
  'linear.comment': 'operate',
  'build.pull': 'operate',
  'build.run': 'operate',
  'build.cancel': 'operate',
  'attachment.save': 'operate',
  'accounts.refresh': 'operate',
  // Account sync between hosts (thread V): only an admin key moves a credential, local only decides where sign-ins go.
  'accounts.sync': 'local',
  'accounts.setHome': 'local',
  'accounts.delete': 'local',
  'notes.upsert': 'operate',
  'notes.delete': 'operate',
  'projectLogo.save': 'operate',
  'projectLogo.remove': 'operate',
  'text.generate': 'operate',
  'session.create': 'operate', // permission: 'auto' needs approve (requiredCapability)
  'session.send': 'operate',
  'session.interrupt': 'operate',
  'session.pause': 'operate',
  'session.resume': 'operate',
  'session.continueAllErrors': 'operate',
  'session.pauseAllRunning': 'operate',
  'session.resumeAllPaused': 'operate',
  'session.batch': 'operate',
  'session.rename': 'operate',
  'session.notes.get': 'read',
  'session.notes.set': 'operate',
  'session.setThreadRules': 'operate',
  'session.archive': 'operate',
  // Thread resources (contract-resources.ts): ids only, never a caller path; removal runs on the owning host.
  'resources.list': 'read',
  'resources.listAll': 'read',
  'resources.remove': 'operate',
  'session.delete': 'operate',
  'session.restart': 'operate',
  'session.continue': 'operate',
  'session.reroute': 'operate',
  'session.answer': 'operate',
  'session.tune': 'operate',
  'session.retype': 'operate',
  'session.setGoal': 'operate',
  'session.clearGoal': 'operate',
  'session.compact': 'operate',
  'session.killBackground': 'operate',
  'session.pin': 'operate',
  'queue.add': 'operate',
  'queue.remove': 'operate',
  'queue.update': 'operate',
  'queue.reorder': 'operate',
  'queue.steer': 'operate',

  // approve: anything that lets a thread act without a prompt
  'session.approve': 'approve',
  'session.permission': 'approve',

  // admin
  'rules.set': 'admin',
  'defaults.set': 'admin',
  'plans.set': 'admin',
  'plan.implement': 'operate',
  'turnpass.set': 'admin',
  'build.set': 'admin',
  'appshots.set': 'admin',
  'project.setAccounts': 'admin',
  'workspace.setAccounts': 'admin',
  'project.setPreamble': 'admin',
  'workspace.setPreamble': 'admin',
  'linear.setToken': 'admin',
  // A paired phone registers its own push token (thread L6): the key's own row, read suffices.
  'remote.push.register': 'read',
  'remote.push.unregister': 'read',
  'remote.push.status': 'read',
  'remote.push.activity': 'read',
  'remote.status': 'admin',
  'remote.keys.list': 'admin',
  'remote.keys.create': 'admin',
  'remote.keys.revoke': 'admin',
  'remote.pairings.create': 'admin',
  'remote.pairings.list': 'admin',
  'remote.pairings.revoke': 'admin',
  'remote.sessions.list': 'admin',
  'remote.sessions.revoke': 'admin',
  'remote.settings.set': 'admin',
  'accounts.push': 'admin',
  'accounts.pull': 'admin',
  'accounts.confirm': 'admin',
  'accounts.released': 'admin',
  'accounts.removed': 'admin',
  'accounts.headroom': 'admin',
  // Harness config sync (remote/harnessSync.ts): another host's main process mirrors its config here; the pane's status and Sync now.
  'harness.manifest': 'admin',
  'harness.file': 'admin',
  'harness.commit': 'admin',
  'harness.status': 'admin',
  'harness.sync': 'admin',
  'harness.settings.set': 'admin',
  // Memory sync (remote/memorySync.ts): the harnesses' notes cross both ways between hosts; the pane's status and Sync now.
  'memory.exchange': 'admin',
  'memory.files': 'admin',
  'memory.status': 'admin',
  'memory.sync': 'admin',
  'memory.settings.set': 'admin',
  // Attachments on a remote thread (contract-attachments.ts): upload into the thread's dir; read a file here in ranges for an uploader.
  'attachment.begin': 'operate',
  'attachment.chunk': 'operate',
  'attachment.commit': 'operate',
  'attachment.abort': 'operate',
  'attachment.digest': 'read',
  'attachment.readRange': 'read',
  'attachment.settings': 'read',
  'attachment.settings.set': 'admin',
  // Moving a thread between hosts (contract-session-move.ts): the desktop starts it; peers answer as admin.
  'session.move': 'local',
  'session.import.begin': 'admin',
  'session.import.part': 'admin',
  'session.import.branch.chunk': 'admin',
  'session.import.branch.commit': 'admin',
  'session.import.commit': 'admin',
  'session.import.release': 'admin',
  'session.import.abort': 'admin',
  'session.export.begin': 'admin',
  'session.export.branch.begin': 'admin',
  'session.export.branch.chunk': 'admin',
  'session.export.part': 'admin',
  'session.export.commit': 'admin',
  'session.export.abort': 'admin',
  'session.move.status': 'admin',
  'session.move.preview': 'admin',
  // The Mac bridge (contract-macbridge.ts, docs/box.md): the Mac's main process registers on
  // the box's link and answers its calls; a box thread's own tools are loopback-only (and
  // carry the thread's token); turning the bridge on for a thread lets it act without a box
  // prompt, so it needs approve; only the Mac's own renderer decides and sets the policy.
  'peer.register': 'admin',
  'peer.reply': 'admin',
  'peer.chunk': 'admin',
  'peer.progress': 'admin',
  'peer.pull': 'admin',
  // A Mac reporting that a thread it runs for this host settled (contract-crosshost.ts); rides its admin link.
  'crossHost.settled': 'admin',
  'mac.readFile': 'local',
  'mac.listDir': 'local',
  'mac.fetchFile': 'local',
  'mac.run': 'local',
  'mac.writeFile': 'local',
  'macBridge.thread.get': 'read',
  'macBridge.thread.set': 'approve',
  'macBridge.pending': 'local',
  'macBridge.decide': 'local',
  'macBridge.policy.get': 'local',
  'macBridge.policy.set': 'local',
  'macBridge.shared.set': 'local',
  'macBridge.showRunning.set': 'local',
  'macBridge.limits.set': 'local',
  'macBridge.loadLimit.set': 'local',
  'macBridge.load.get': 'local',
  'macBridge.admitThread': 'local',
  // The Mac's remembered approvals (contract-macbridge-rules.ts): only its own renderer.
  'macBridge.rules.list': 'local',
  'macBridge.rules.forget': 'local',
  // Interactive jobs on the Mac (contract-macjobs.ts): a box thread's own, like mac.run.
  'mac.jobWrite': 'local',
  'mac.jobRead': 'local',
  'mac.jobSignal': 'local',
  'mac.jobClose': 'local',
  // Deploy and publish from the app (contract-host.ts): a deploy of the box
  // is asked over its link under an admin key; the Mac release signs and
  // uploads from this machine and is this machine's renderer's alone.
  'host.deployStatus': 'admin',
  'host.deploy': 'admin',
  'host.log': 'admin',
  'host.publishStatus': 'local',
  'host.publish': 'local',
  'host.publishStop': 'local',
  'host.releaseCheckout.set': 'local',
  // Devices on a Mac (contract-hostdevices.ts): what the Mac runs for its threads; anyone with a key may look, operate acts on a simulator.
  'host.devices.hosts': 'read',
  'host.devices': 'read',
  'host.devices.watch': 'read',
  'host.devices.unwatch': 'read',
  'host.simulator.shutdown': 'operate',
  'host.simulator.delete': 'operate',
  'host.device.openXcode': 'operate',
  // Saved hosts and their keys never leave this machine (thread K1).
  'remote.environments.list': 'local',
  'deploy.master': 'local',
  'remote.environments.add': 'local',
  'remote.environments.update': 'local',
  'remote.environments.remove': 'local',
  'remote.environments.ticket': 'local',
  'remote.environments.pair': 'local'
}

/** The capability one request needs: the table row, plus the one
 *  param-level rule (a full-access thread skips every prompt). */
export function requiredCapability(req: { method: ClientRequest['method']; params?: unknown }): MethodCapability {
  if (req.method === 'session.create' && (req.params as { permission?: string } | undefined)?.permission === 'auto')
    return 'approve'
  return METHOD_CAPABILITY[req.method]
}

/** `read` is implied, `admin` covers everything. */
export function allows(caps: Iterable<Capability>, need: Capability): boolean {
  if (need === 'read') return true
  for (const cap of caps) if (cap === need || cap === 'admin') return true
  return false
}

/** Parse a stored or requested cap list; unknown names are dropped, `read` is always present, sorted. */
export function normalizeCaps(input: Iterable<string>): Capability[] {
  const set = new Set<Capability>(['read'])
  for (const cap of input) if ((CAPABILITIES as readonly string[]).includes(cap)) set.add(cap as Capability)
  return [...set].sort()
}

export const isCapability = (value: string): value is Capability =>
  (CAPABILITIES as readonly string[]).includes(value)

/** Who a socket or request belongs to. The loopback socket is `local` and
 *  gets everything; a remote caller carries the key row it resolved to. */
export type Principal =
  | { kind: 'local' }
  | {
      kind: 'remote'
      keyId: string
      name: string
      audience: 'client' | 'mcp'
      caps: Capability[]
      /** The browser session behind a cookie-authenticated caller, if any. */
      sessionId?: string
    }

export const LOCAL_PRINCIPAL: Principal = { kind: 'local' }

/** The caps a hello frame reports for a principal. */
export function principalCaps(principal: Principal): Capability[] {
  return principal.kind === 'local' ? [...CAPABILITIES] : principal.caps
}
