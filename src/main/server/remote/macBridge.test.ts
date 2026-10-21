import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MacBridgePush, MacBridgeRequest, MacCallParams, MacListDirResult, MacReadFileResult, MacRunResult, MacFetchFileWire } from '@shared/contract-macbridge'
import { MacBridge, asText, commandKey, readVerdict, rememberFolder, validateSharedFolder } from './macBridge'

let root: string
let home: string
let shared: string
let elsewhere: string
let managed: string

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tc-macbridge-')))
  home = join(root, 'Users', 'me')
  shared = join(home, 'Documents', 'shared')
  elsewhere = join(home, 'Private')
  managed = join(home, 'IdeaProjects', 'app')
  for (const d of [shared, elsewhere, managed, join(elsewhere, 'sub')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(shared, 'notes.md'), 'shared notes')
  writeFileSync(join(elsewhere, 'secret.txt'), 'private')
  writeFileSync(join(elsewhere, 'sub', 'deep.txt'), 'deep')
  writeFileSync(join(home, 'top.txt'), 'at home')
  writeFileSync(join(managed, 'README.md'), 'managed')
  writeFileSync(join(shared, 'bin.dat'), Buffer.from([0, 1, 2, 255]))
  symlinkSync(join(elsewhere, 'secret.txt'), join(shared, 'link-out'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('validateSharedFolder', () => {
  it('takes an absolute folder by its real path', () => {
    expect(validateSharedFolder(shared, home)).toBe(shared)
    expect(validateSharedFolder(join(shared, '..', 'shared'), home)).toBe(shared)
  })
  it('refuses /, the home directory, anything above it, relative paths, files and missing folders', () => {
    expect(() => validateSharedFolder('/', home)).toThrow(/whole home directory or disk/)
    expect(() => validateSharedFolder(home, home)).toThrow(/whole home/)
    expect(() => validateSharedFolder(`${home}/`, home)).toThrow(/whole home/)
    expect(() => validateSharedFolder(join(root, 'Users'), home)).toThrow(/whole home/)
    expect(() => validateSharedFolder('Documents', home)).toThrow(/absolute/)
    expect(() => validateSharedFolder('~/Documents', home)).toThrow(/absolute/)
    expect(() => validateSharedFolder(join(shared, 'notes.md'), home)).toThrow(/not a folder/)
    expect(() => validateSharedFolder(join(home, 'nope'), home)).toThrow(/not a folder/)
  })
})

describe('rememberFolder', () => {
  it('a file remembers its folder, a listing the folder itself', () => {
    expect(rememberFolder(join(elsewhere, 'secret.txt'), false, home)).toBe(elsewhere)
    expect(rememberFolder(elsewhere, true, home)).toBe(elsewhere)
  })
  it('never home, never above it', () => {
    expect(rememberFolder(join(home, 'top.txt'), false, home)).toBeNull()
    expect(rememberFolder(home, true, home)).toBeNull()
    expect(rememberFolder('/etc', true, home)).toBe('/etc')
    expect(rememberFolder('/', true, home)).toBeNull()
    expect(rememberFolder('/hosts', false, home)).toBeNull()
  })
})

describe('readVerdict', () => {
  it('managed roots, shared folders, remembered folders, else ask', () => {
    const rules = { managed: [managed], shared: [shared], remembered: [join(elsewhere, 'sub')] }
    expect(readVerdict(join(managed, 'README.md'), rules)).toEqual({ allow: true, why: 'managed' })
    expect(readVerdict(join(shared, 'notes.md'), rules)).toEqual({ allow: true, why: 'shared' })
    expect(readVerdict(join(elsewhere, 'sub', 'deep.txt'), rules)).toEqual({ allow: true, why: 'remembered' })
    expect(readVerdict(join(elsewhere, 'secret.txt'), rules)).toEqual({ allow: false })
    expect(readVerdict(join(shared, 'link-out'), rules)).toEqual({ allow: false })
    expect(readVerdict(home, rules)).toEqual({ allow: false })
  })
})

describe('asText', () => {
  it('decodes text, trims a cut character, refuses binary', () => {
    expect(asText(Buffer.from('héllo'))).toBe('héllo')
    expect(asText(Buffer.from('hé').subarray(0, 2))).toBe('h')
    expect(asText(Buffer.from([0, 1, 2]))).toBeNull()
    expect(asText(Buffer.from([0xff, 0xfe, 0x41, 0x41, 0x41, 0x41]))).toBeNull()
  })
})

function bridge(opts: { managed?: string[] } = {}) {
  const settings = new Map<string, string>()
  const pushes: MacBridgePush[] = []
  const lines: string[] = []
  const mb = new MacBridge({
    environmentId: 'env_mac',
    store: { getSetting: (k) => settings.get(k) ?? null, setSetting: (k, v) => (v === null ? settings.delete(k) : settings.set(k, v)) },
    managedRoots: () => opts.managed ?? [managed],
    environments: () => [{ id: 'env_box', name: 'box' }],
    link: () => null,
    home,
    shell: '/bin/sh',
    log: (l) => lines.push(l)
  })
  mb.subscribe((p) => pushes.push(p))
  const requests = (): MacBridgeRequest[] => pushes.filter((p): p is Extract<MacBridgePush, { push: 'macBridge.request' }> => p.push === 'macBridge.request').map((p) => p.request)
  /** The request at `index` (in push order), once it has shown up. */
  const nextRequest = async (index = 0): Promise<MacBridgeRequest> => {
    for (let i = 0; i < 200; i++) {
      if (requests().length > index) return requests()[index]
      await new Promise((ok) => setTimeout(ok, 5))
    }
    throw new Error('no request')
  }
  const call = <T,>(method: Parameters<MacBridge['handle']>[0], args: MacCallParams['args'], thread = 's1', deadlineMs = 15 * 60_000) =>
    mb.handle(method, { thread: { id: thread, title: `thread ${thread}` }, args }, { from: 'env_box', deadlineAt: Date.now() + deadlineMs }) as Promise<T>
  return { mb, settings, pushes, lines, requests, nextRequest, call }
}

describe('MacBridge policy', () => {
  it('off by default: every call refused, nothing asked', async () => {
    const b = bridge()
    expect(b.mb.policyOf('env_box')).toBe('off')
    await expect(b.call('mac.readFile', { path: join(shared, 'notes.md') })).rejects.toThrow(/off for this host/)
    expect(b.requests()).toEqual([])
    expect(b.lines[0]).toMatch(/box \(env_box\) thread=s1 mac.readFile → refused \(bridge off\)/)
  })

  it('an unknown host is refused, and so is a policy for one', async () => {
    const b = bridge()
    await expect(b.mb.handle('mac.listDir', { thread: { id: 's', title: '' }, args: { path: shared } }, { from: 'env_other', deadlineAt: Date.now() + 1000 })).rejects.toThrow(/does not know/)
    expect(() => b.mb.setPolicy('env_other', 'read')).toThrow(/unknown host/)
  })

  it('shared folders refuse home and /, and the list is kept by real path', () => {
    const b = bridge()
    expect(() => b.mb.setShared('env_box', [shared, home])).toThrow(/whole home/)
    expect(b.mb.sharedOf('env_box')).toEqual([])
    b.mb.setShared('env_box', [shared, join(shared, '.')])
    expect(b.mb.sharedOf('env_box')).toEqual([shared])
    expect(b.mb.hosts()).toEqual([{ environmentId: 'env_box', name: 'box', policy: 'off', shared: [shared], registered: false }])
  })

  it('read: shared folders and managed roots without asking, contents never in the log', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read')
    b.mb.setShared('env_box', [shared])
    const file = await b.call<MacReadFileResult>('mac.readFile', { path: join(shared, 'notes.md') })
    expect(file).toMatchObject({ content: 'shared notes', encoding: 'utf8', truncated: false, size: 12 })
    const bin = await b.call<MacReadFileResult>('mac.readFile', { path: join(shared, 'bin.dat') })
    expect(bin).toMatchObject({ encoding: 'base64', content: Buffer.from([0, 1, 2, 255]).toString('base64') })
    const cut = await b.call<MacReadFileResult>('mac.readFile', { path: join(shared, 'notes.md'), maxBytes: 6 })
    expect(cut).toMatchObject({ content: 'shared', truncated: true, bytes: 6 })
    const dir = await b.call<MacListDirResult>('mac.listDir', { path: shared })
    expect(dir.entries.map((e) => `${e.name}:${e.kind}`)).toEqual(['bin.dat:file', 'link-out:link', 'notes.md:file'])
    expect((await b.call<MacReadFileResult>('mac.readFile', { path: join(managed, 'README.md') })).content).toBe('managed')
    const fetched = await b.call<MacFetchFileWire>('mac.fetchFile', { path: join(shared, 'notes.md') })
    expect(Buffer.from(fetched.dataBase64, 'base64').toString()).toBe('shared notes')
    expect(b.requests()).toEqual([])
    expect(b.lines.every((l) => !l.includes('shared notes'))).toBe(true)
    expect(b.lines.filter((l) => l.includes('allowed (shared)')).length).toBe(5)
  })

  it('read: relative and ~ paths are refused (the box\'s home is not this one)', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read')
    await expect(b.call('mac.readFile', { path: '~/x' })).rejects.toThrow(/absolute/)
    await expect(b.call('mac.readFile', { path: 'x' })).rejects.toThrow(/absolute/)
  })

  it('read outside: asks; a denial is an error; allow + remember admits the folder for that thread only', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read')
    b.mb.setShared('env_box', [shared])
    const denied = b.call('mac.readFile', { path: join(elsewhere, 'secret.txt') })
    const r1 = await b.nextRequest()
    expect(r1).toMatchObject({ kind: 'read', method: 'mac.readFile', path: join(elsewhere, 'secret.txt'), folder: elsewhere, hostName: 'box', sessionId: 's1', threadTitle: 'thread s1', status: 'pending' })
    expect(b.mb.pending().map((r) => r.id)).toEqual([r1.id])
    b.mb.decide(r1.id, false)
    await expect(denied).rejects.toThrow('denied at the Mac')
    expect(b.pushes).toContainEqual({ push: 'macBridge.resolved', id: r1.id, outcome: 'denied' })
    expect(b.mb.pending()).toEqual([])

    const allowed = b.call<MacReadFileResult>('mac.readFile', { path: join(elsewhere, 'secret.txt') })
    const r2 = await b.nextRequest(1)
    b.mb.decide(r2.id, true, true)
    expect((await allowed).content).toBe('private')
    // Remembered: the same folder (and below) for s1 goes through.
    expect((await b.call<MacReadFileResult>('mac.readFile', { path: join(elsewhere, 'sub', 'deep.txt') })).content).toBe('deep')
    expect(b.requests().length).toBe(2)
    // Another thread asks again.
    const other = b.call('mac.readFile', { path: join(elsewhere, 'secret.txt') }, 's2')
    const r3 = await b.nextRequest(2)
    expect(r3.sessionId).toBe('s2')
    b.mb.decide(r3.id, false)
    await expect(other).rejects.toThrow('denied')
    // A symlink out of a shared folder is read by where it points: asks.
    const link = b.call('mac.readFile', { path: join(shared, 'link-out') }, 's3')
    const r4 = await b.nextRequest(3)
    expect(r4.path).toBe(join(elsewhere, 'secret.txt'))
    b.mb.decide(r4.id, false)
    await expect(link).rejects.toThrow('denied')
    expect(() => b.mb.decide(r4.id, true)).toThrow(/no longer waiting/)
  })

  it('a file directly in home can be allowed once, never remembered as a folder', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read')
    const first = b.call<MacReadFileResult>('mac.readFile', { path: join(home, 'top.txt') })
    const r1 = await b.nextRequest()
    expect(r1.folder).toBeUndefined()
    b.mb.decide(r1.id, true, true)
    expect((await first).content).toBe('at home')
    const again = b.call('mac.readFile', { path: join(home, 'top.txt') })
    const r2 = await b.nextRequest(1)
    b.mb.decide(r2.id, false)
    await expect(again).rejects.toThrow('denied')
  })

  it('an unanswered request expires within the box\'s deadline', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read')
    await expect(b.call('mac.listDir', { path: elsewhere }, 's1', 3_100)).rejects.toThrow(/nobody at the Mac answered/)
    expect(b.pushes.at(-1)).toMatchObject({ push: 'macBridge.resolved', outcome: 'expired' })
  })
})

describe('MacBridge commands', () => {
  it('read policy refuses commands', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read')
    await expect(b.call('mac.run', { argv: ['echo', 'hi'] })).rejects.toThrow(/not run commands/)
  })

  it('every command asks with argv and cwd; allow runs it; remember admits that exact command for that thread', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read+run')
    const first = b.call<MacRunResult>('mac.run', { argv: ['/bin/echo', 'hello mac'], cwd: shared })
    const r1 = await b.nextRequest()
    expect(r1).toMatchObject({ kind: 'run', method: 'mac.run', argv: ['/bin/echo', 'hello mac'], cwd: shared, status: 'pending', timeoutMs: 120_000 })
    b.mb.decide(r1.id, true, true)
    const out = await first
    expect(out).toMatchObject({ exitCode: 0, stdout: 'hello mac\n', timedOut: false, truncated: false })
    expect(b.pushes).toContainEqual({ push: 'macBridge.resolved', id: r1.id, outcome: 'done' })
    // The same argv and cwd: runs at once, still shown on the Mac as running.
    const second = await b.call<MacRunResult>('mac.run', { argv: ['/bin/echo', 'hello mac'], cwd: shared })
    expect(second.stdout).toBe('hello mac\n')
    const shown = b.requests().filter((r) => r.kind === 'run')
    expect(shown.length).toBeGreaterThanOrEqual(2)
    expect(shown.at(-1)?.status).toBe('running')
    // Another cwd, another argv, or another thread: asks again.
    const elsewhereRun = b.call('mac.run', { argv: ['/bin/echo', 'hello mac'], cwd: elsewhere })
    const r3 = await b.nextRequest(b.requests().length - 1)
    expect(r3.cwd).toBe(elsewhere)
    b.mb.decide(r3.id, false)
    await expect(elsewhereRun).rejects.toThrow('denied')
    const otherThread = b.call('mac.run', { argv: ['/bin/echo', 'hello mac'], cwd: shared }, 's2')
    const r4 = await b.nextRequest(b.requests().length - 1)
    expect(r4.sessionId).toBe('s2')
    b.mb.decide(r4.id, false)
    await expect(otherThread).rejects.toThrow('denied')
    expect(b.lines.some((l) => l.includes('mac.run → allowed (remembered) argv0=echo'))).toBe(true)
  })

  it('a running command can be stopped from the Mac, which kills it', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read+run')
    const run = b.call<MacRunResult>('mac.run', { command: 'sleep 30', cwd: shared })
    const r1 = await b.nextRequest()
    b.mb.decide(r1.id, true)
    const running = await b.nextRequest(1)
    expect(running.status).toBe('running')
    expect(() => b.mb.decide(r1.id, true)).toThrow(/already running/)
    b.mb.decide(r1.id, false)
    const result = await run
    expect(result.exitCode === 0).toBe(false)
    expect(b.pushes.at(-1)).toMatchObject({ push: 'macBridge.resolved', id: r1.id, outcome: 'stopped' })
  })

  it('the timeout is enforced on the Mac', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read+run')
    const run = b.call<MacRunResult>('mac.run', { command: 'sleep 30', cwd: shared, timeoutMs: 1_000 })
    b.mb.decide((await b.nextRequest()).id, true)
    const result = await run
    expect(result.timedOut).toBe(true)
  })

  it('argv xor command; a missing cwd is refused', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read+run')
    await expect(b.call('mac.run', { argv: ['a'], command: 'a' })).rejects.toThrow(/one of them/)
    await expect(b.call('mac.run', {})).rejects.toThrow(/one of them/)
    await expect(b.call('mac.run', { argv: ['ls'], cwd: join(home, 'nope') })).rejects.toThrow(/no such folder/)
  })

  it('the command key is argv or command, and cwd', () => {
    expect(commandKey({ argv: ['a', 'b'], cwd: '/x' })).not.toBe(commandKey({ command: 'a b', cwd: '/x' }))
    expect(commandKey({ argv: ['a', 'b'], cwd: '/x' })).not.toBe(commandKey({ argv: ['a', 'b'], cwd: '/y' }))
    expect(commandKey({ argv: ['a b'], cwd: '/x' })).not.toBe(commandKey({ argv: ['a', 'b'], cwd: '/x' }))
  })
})
