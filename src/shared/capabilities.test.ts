import { describe, expect, it } from 'vitest'
import { ClientRequestSchema } from './contract'
import { METHOD_CAPABILITY, allows, normalizeCaps, requiredCapability } from './capabilities'

const methods = (ClientRequestSchema.options as { shape: { method: { value: string } } }[]).map(
  (o) => o.shape.method.value
)
const withCap = (cap: string): string[] =>
  Object.entries(METHOD_CAPABILITY)
    .filter(([, c]) => c === cap)
    .map(([m]) => m)
    .sort()

describe('METHOD_CAPABILITY', () => {
  it('covers every contract method exactly once', () => {
    expect(Object.keys(METHOD_CAPABILITY).sort()).toEqual([...methods].sort())
  })
  it('keeps the host-process and bridge methods local-only', () => {
    expect(withCap('local')).toEqual(
      [
        ...methods.filter((m) => m.startsWith('app.')),
        'stall.report',
        'deploy.master',
        'dap.connect',
        'lsp.ensure',
        'lsp.status',
        'idea.eula',
        'idea.acceptEula',
        'idea.checkUpdate',
        'providers.update',
        'fim.complete',
        // Saved hosts and their keys never leave this machine (thread K1).
        ...methods.filter((m) => m.startsWith('remote.environments.')),
        // Where sign-ins are handed to, and a sync on demand, are this machine's to decide (thread V).
        'accounts.sync',
        'accounts.setHome',
        'accounts.delete',
        // Only the desktop starts a thread's move between hosts (contract-session-move.ts).
        'session.move',
        // A proof's seam (isolated instances only): a status with no harness, for the e2e's pause step.
        'session.markStatus',
        // The Mac bridge: a box thread's own tools (token-gated), and the Mac's decisions and policy.
        ...methods.filter((m) => m.startsWith('mac.')),
        ...methods.filter((m) => m.startsWith('macBridge.') && !m.startsWith('macBridge.thread.')),
        // The Mac release signs and uploads from this machine (contract-host.ts).
        'host.publishStatus',
        'host.publish',
        'host.publishStop',
        'host.releaseCheckout.set'
      ].sort()
    )
  })
  it('approve covers exactly the prompt-skipping methods', () => {
    // macBridge.thread.set lets a box thread call the Mac without a box prompt (the Mac still asks for itself).
    expect(withCap('approve')).toEqual(['macBridge.thread.set', 'review.override', 'session.approve', 'session.permission'])
  })
  it('admin covers settings writes and remote management', () => {
    expect(withCap('admin')).toEqual(
      [
        'doctor.profile',
        'rules.set',
        'defaults.set',
        // What happens when a plan completes (plans.ts): a settings write.
        'plans.set',
        'turnpass.set',
        'review.set',
        'build.set',
        'appshots.set',
        'project.setAccounts',
        'session.setMaster',
        'workspace.setAccounts',
        'project.setPreamble',
        'workspace.setPreamble',
        'linear.setToken',
        // A phone's own push registration (remote.push.*) is the key's row: read.
        ...methods.filter((m) => m.startsWith('remote.') && !m.startsWith('remote.environments.') && !m.startsWith('remote.push.')),
        // A credential moves between hosts only under an admin key (thread V).
        'accounts.push',
        'accounts.pull',
        'accounts.confirm',
        'accounts.released',
        'accounts.removed',
        // A host's rate-limit picture crosses only between the hosts' main processes.
        'accounts.headroom',
        // The harness config crosses between hosts, and its status and settings are changed, only under an admin key.
        ...methods.filter((m) => m.startsWith('harness.')),
        // The harnesses' memory crosses both ways, and its status and settings are changed, only under an admin key.
        ...methods.filter((m) => m.startsWith('memory.')),
        // A host's per-file attachment limit.
        'attachment.settings.set',
        // A stored agent page, read by another host's main process over the peer link.
        'page.read',
        // A slice of a media file by its token, the same way.
        'media.read',
        // A thread crosses between hosts only under an admin key; the desktop's session.move drives these.
        ...methods.filter((m) => m.startsWith('session.import.') || m.startsWith('session.export.')),
        'session.move.status',
        'session.move.preview',
        // The reverse RPC a Mac's main process speaks on its link to this host, and its settle report (contract-crosshost.ts).
        ...methods.filter((m) => m.startsWith('peer.')),
        'crossHost.settled',
        'crossHost.landing',
        // A thread on this host asked for by another host's main process over its link (contract-crosshost.ts).
        ...methods.filter((m) => m.startsWith('thread.')),
        // A deploy of this host, and its log, are asked over its link under an admin key (contract-host.ts).
        'host.deploy',
        'host.deployStatus',
        'host.log',
        // A host's running cap (contract-admission.ts): a settings write.
        'admission.set'
      ].sort()
    )
  })
})

describe('push registration (thread L6)', () => {
  it('is read: any paired key registers its own device', () => {
    expect(methods.filter((m) => m.startsWith('remote.push.')).sort()).toEqual(['remote.push.activity', 'remote.push.register', 'remote.push.status', 'remote.push.unregister'])
    for (const m of methods.filter((m) => m.startsWith('remote.push.'))) expect(METHOD_CAPABILITY[m as keyof typeof METHOD_CAPABILITY]).toBe('read')
  })
})

describe('requiredCapability', () => {
  it('session.create needs approve only for an auto thread', () => {
    expect(requiredCapability({ method: 'session.create', params: { permission: 'auto' } } as never)).toBe('approve')
    expect(requiredCapability({ method: 'session.create', params: { permission: 'edits' } } as never)).toBe('operate')
    expect(requiredCapability({ method: 'session.create', params: {} } as never)).toBe('operate')
  })
})

describe('allows', () => {
  it('read is implied, admin covers all, the rest are literal', () => {
    expect(allows([], 'read')).toBe(true)
    expect(allows([], 'operate')).toBe(false)
    expect(allows(['operate'], 'operate')).toBe(true)
    expect(allows(['operate'], 'approve')).toBe(false)
    expect(allows(['admin'], 'approve')).toBe(true)
    expect(allows(['admin'], 'operate')).toBe(true)
  })
  it('normalizeCaps adds read, drops junk and sorts', () => {
    expect(normalizeCaps(['operate', 'bogus', 'operate'])).toEqual(['operate', 'read'])
    expect(normalizeCaps([])).toEqual(['read'])
  })
})

describe('the Mac bridge (contract-macbridge.ts)', () => {
  it('no key can ever decide or set the Mac\'s policy, and a thread\'s tools stay on the loopback', () => {
    for (const m of ['macBridge.decide', 'macBridge.pending', 'macBridge.policy.get', 'macBridge.policy.set', 'macBridge.shared.set', 'mac.readFile', 'mac.listDir', 'mac.fetchFile', 'mac.run', 'mac.writeFile'] as const)
      expect(METHOD_CAPABILITY[m]).toBe('local')
    expect(METHOD_CAPABILITY['macBridge.thread.get']).toBe('read')
  })
})
