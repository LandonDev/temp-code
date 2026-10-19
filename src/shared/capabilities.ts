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
  'defaults.get': 'read',
  'turnpass.get': 'read',
  'appshots.get': 'read',
  'commands.list': 'read',
  'attachment.read': 'read',
  'accounts.list': 'read',
  'notes.get': 'read',
  'notes.list': 'read',
  'search.project': 'read',
  'session.search': 'read',
  'session.list': 'read',
  'session.events': 'read',
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
  'session.rename': 'operate',
  'session.setThreadRules': 'operate',
  'session.archive': 'operate',
  'session.delete': 'operate',
  'session.restart': 'operate',
  'session.continue': 'operate',
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
  'turnpass.set': 'admin',
  'build.set': 'admin',
  'appshots.set': 'admin',
  'project.setAccounts': 'admin',
  'workspace.setAccounts': 'admin',
  'linear.setToken': 'admin',
  'remote.status': 'admin'
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
