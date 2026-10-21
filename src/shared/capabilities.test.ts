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
        // Only the desktop starts a thread's move between hosts (contract-session-move.ts).
        'session.move'
      ].sort()
    )
  })
  it('approve covers exactly the prompt-skipping methods', () => {
    expect(withCap('approve')).toEqual(['session.approve', 'session.permission'])
  })
  it('admin covers settings writes and remote management', () => {
    expect(withCap('admin')).toEqual(
      [
        'rules.set',
        'defaults.set',
        'turnpass.set',
        'build.set',
        'appshots.set',
        'project.setAccounts',
        'workspace.setAccounts',
        'linear.setToken',
        // A phone's own push registration (remote.push.*) is the key's row: read.
        ...methods.filter((m) => m.startsWith('remote.') && !m.startsWith('remote.environments.') && !m.startsWith('remote.push.')),
        // A credential moves between hosts only under an admin key (thread V).
        'accounts.push',
        'accounts.pull',
        'accounts.confirm',
        'accounts.released',
        // The harness config crosses between hosts, and its status and settings are changed, only under an admin key.
        ...methods.filter((m) => m.startsWith('harness.')),
        // A host's per-file attachment limit.
        'attachment.settings.set',
        // A thread crosses between hosts only under an admin key; the desktop's session.move drives these.
        ...methods.filter((m) => m.startsWith('session.import.') || m.startsWith('session.export.')),
        'session.move.status'
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
