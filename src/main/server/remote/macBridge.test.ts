import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  MacBridgePush,
  MacBridgeRequest,
  MacCallParams,
  MacListDirResult,
  MacReadFileResult,
  MacRunResult,
  MacFetchFileWire
} from '@shared/contract-macbridge'
import {
  FULL_DENY_DIRS,
  FULL_DENY_FILES,
  MacBridge,
  asText,
  commandKey,
  macDenied,
  macPath,
  readVerdict,
  rememberFolder,
  runPresentation,
  showRunningDefault,
  validateSharedFolder
} from './macBridge'

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
  for (const d of [shared, elsewhere, managed, join(elsewhere, 'sub')])
    mkdirSync(d, { recursive: true })
  writeFileSync(join(shared, 'notes.md'), 'shared notes')
  writeFileSync(join(elsewhere, 'secret.txt'), 'private')
  writeFileSync(join(elsewhere, 'sub', 'deep.txt'), 'deep')
  writeFileSync(join(home, 'top.txt'), 'at home')
  writeFileSync(join(managed, 'README.md'), 'managed')
  writeFileSync(join(shared, 'bin.dat'), Buffer.from([0, 1, 2, 255]))
  symlinkSync(join(elsewhere, 'secret.txt'), join(shared, 'link-out'))
  // The keys and credentials full access still asks for, each with a file inside.
  for (const d of FULL_DENY_DIRS) {
    mkdirSync(join(home, d), { recursive: true })
    writeFileSync(join(home, d, 'inside'), 'key material')
  }
  for (const f of FULL_DENY_FILES) {
    mkdirSync(join(home, f, '..'), { recursive: true })
    writeFileSync(join(home, f), '{"token":"x"}')
  }
  writeFileSync(join(elsewhere, 'server.pem'), 'pem')
  writeFileSync(join(elsewhere, 'settings.local.json'), '{}')
  // Symlinks into deny-list folders, from a readable place.
  symlinkSync(join(home, '.ssh', 'inside'), join(elsewhere, 'looks-harmless'))
  symlinkSync(join(home, '.aws'), join(elsewhere, 'cloud'))
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
    expect(readVerdict(join(elsewhere, 'sub', 'deep.txt'), rules)).toEqual({
      allow: true,
      why: 'remembered'
    })
    expect(readVerdict(join(elsewhere, 'secret.txt'), rules)).toEqual({ allow: false })
    expect(readVerdict(join(shared, 'link-out'), rules)).toEqual({ allow: false })
    expect(readVerdict(home, rules)).toEqual({ allow: false })
  })
})

describe('macPath', () => {
  it("~ and ~/… are the Mac's home; relative and ~user are refused", () => {
    expect(macPath('~', home)).toBe(home)
    expect(macPath('~/Documents/shared', home)).toBe(shared)
    expect(macPath(join(shared, '..', 'shared'), home)).toBe(shared)
    expect(() => macPath('Documents', home)).toThrow(/absolute or start with ~\//)
    expect(() => macPath('~other/x', home)).toThrow(/absolute or start with ~\//)
  })
  it('a path that does not exist keeps its spelling: nothing about it is read', () => {
    expect(macPath(join(root, 'Users', 'someone-else', 'Desktop'), home)).toBe(
      join(root, 'Users', 'someone-else', 'Desktop')
    )
  })
})

describe('macDenied (full access)', () => {
  it('every deny-list folder, file and anything below them, by literal path', () => {
    for (const d of FULL_DENY_DIRS) {
      expect(macDenied(join(home, d), home)).toBe(true)
      expect(macDenied(join(home, d, 'inside'), home)).toBe(true)
    }
    for (const f of FULL_DENY_FILES) expect(macDenied(join(home, f), home)).toBe(true)
  })
  it('case-folded, since a Mac volume is case-insensitive', () => {
    expect(macDenied(join(home, '.SSH', 'id_ed25519'), home)).toBe(true)
    expect(macDenied(join(home, 'Library', 'keychains'), home)).toBe(true)
  })
  it("the harness sync's secret names, anywhere", () => {
    expect(macDenied(join(elsewhere, 'server.pem'), home)).toBe(true)
    expect(macDenied('/etc/ssl/private/site.KEY', home)).toBe(true)
    expect(macDenied(join(elsewhere, 'settings.local.json'), home)).toBe(true)
    expect(macDenied(join(managed, 'auth.json'), home)).toBe(true)
  })
  it('the folders above home, but not home itself', () => {
    expect(macDenied('/', home)).toBe(true)
    expect(macDenied(join(root, 'Users'), home)).toBe(true)
    expect(macDenied(home, home)).toBe(false)
  })
  it('everything else is readable: home, its folders, other absolute paths', () => {
    expect(macDenied(join(home, 'top.txt'), home)).toBe(false)
    expect(macDenied(join(elsewhere, 'secret.txt'), home)).toBe(false)
    expect(macDenied(join(home, '.config', 'other'), home)).toBe(false)
    expect(macDenied(join(home, '.sshd-notes'), home)).toBe(false)
    expect(macDenied('/etc/hosts', home)).toBe(false)
    expect(macDenied(join(root, 'Users', 'someone-else'), home)).toBe(false)
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

function bridge(opts: { managed?: string[]; load?: { load: number; cores: number } } = {}) {
  const settings = new Map<string, string>()
  const pushes: MacBridgePush[] = []
  const lines: string[] = []
  // The load watch never ticks on its own here; `sample` is what the guard reads when a test calls mb.guard.sample().
  const sample = opts.load ?? { load: 0, cores: 8 }
  const mb = new MacBridge({
    environmentId: 'env_mac',
    store: {
      getSetting: (k) => settings.get(k) ?? null,
      setSetting: (k, v) => (v === null ? settings.delete(k) : settings.set(k, v))
    },
    managedRoots: () => opts.managed ?? [managed],
    environments: () => [{ id: 'env_box', name: 'box' }],
    link: () => null,
    home,
    shell: '/bin/sh',
    log: (l) => lines.push(l),
    load: { sample: () => ({ ...sample }), intervalMs: 0 }
  })
  mb.subscribe((p) => pushes.push(p))
  const requests = (): MacBridgeRequest[] =>
    pushes
      .filter(
        (p): p is Extract<MacBridgePush, { push: 'macBridge.request' }> =>
          p.push === 'macBridge.request'
      )
      .map((p) => p.request)
  /** The request at `index` (in push order), once it has shown up. */
  const nextRequest = async (index = 0): Promise<MacBridgeRequest> => {
    for (let i = 0; i < 200; i++) {
      if (requests().length > index) return requests()[index]
      await new Promise((ok) => setTimeout(ok, 5))
    }
    throw new Error('no request')
  }
  const call = <T>(
    method: Parameters<MacBridge['handle']>[0],
    args: MacCallParams['args'],
    thread = 's1',
    deadlineMs = 15 * 60_000
  ) =>
    mb.handle(
      method,
      { thread: { id: thread, title: `thread ${thread}` }, args },
      { from: 'env_box', deadlineAt: Date.now() + deadlineMs }
    ) as Promise<T>
  return { mb, settings, pushes, lines, requests, nextRequest, call, sample }
}

describe('MacBridge publish routing', () => {
  it('refuses publish methods when their offer handler has not taken the call', async () => {
    const { mb } = bridge()
    for (const method of ['publish.start', 'publish.stop'] as const) {
      await expect(mb.handle(method, {
        caller: { environmentId: 'env_box', sessionId: 'thread' }, args: {}
      }, { from: 'env_box', deadlineAt: Date.now() + 1000 })).rejects.toThrow(`${method} is not a Mac bridge call`)
    }
    mb.close()
  })
})

describe('MacBridge policy', () => {
  it('off by default: every call refused, nothing asked', async () => {
    const b = bridge()
    expect(b.mb.policyOf('env_box')).toBe('off')
    await expect(b.call('mac.readFile', { path: join(shared, 'notes.md') })).rejects.toThrow(
      /off for this host/
    )
    expect(b.requests()).toEqual([])
    expect(b.lines[0]).toMatch(/box \(env_box\) thread=s1 mac.readFile → refused \(bridge off\)/)
  })

  it('an unknown host is refused, and so is a policy for one', async () => {
    const b = bridge()
    await expect(
      b.mb.handle(
        'mac.listDir',
        { thread: { id: 's', title: '' }, args: { path: shared } },
        { from: 'env_other', deadlineAt: Date.now() + 1000 }
      )
    ).rejects.toThrow(/does not know/)
    expect(() => b.mb.setPolicy('env_other', 'read')).toThrow(/unknown host/)
  })

  it('shared folders refuse home and /, and the list is kept by real path', () => {
    const b = bridge()
    expect(() => b.mb.setShared('env_box', [shared, home])).toThrow(/whole home/)
    expect(b.mb.sharedOf('env_box')).toEqual([])
    b.mb.setShared('env_box', [shared, join(shared, '.')])
    expect(b.mb.sharedOf('env_box')).toEqual([shared])
    expect(b.mb.hosts()).toEqual([
      { environmentId: 'env_box', name: 'box', policy: 'off', shared: [shared], showRunning: true,
        registered: false, maxRunning: 4, maxThreads: 2, running: 0, held: 0, threads: 0 }
    ])
  })

  it('read: shared folders and managed roots without asking, contents never in the log', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read')
    b.mb.setShared('env_box', [shared])
    const file = await b.call<MacReadFileResult>('mac.readFile', { path: join(shared, 'notes.md') })
    expect(file).toMatchObject({
      content: 'shared notes',
      encoding: 'utf8',
      truncated: false,
      size: 12
    })
    const bin = await b.call<MacReadFileResult>('mac.readFile', { path: join(shared, 'bin.dat') })
    expect(bin).toMatchObject({
      encoding: 'base64',
      content: Buffer.from([0, 1, 2, 255]).toString('base64')
    })
    const cut = await b.call<MacReadFileResult>('mac.readFile', {
      path: join(shared, 'notes.md'),
      maxBytes: 6
    })
    expect(cut).toMatchObject({ content: 'shared', truncated: true, bytes: 6 })
    const dir = await b.call<MacListDirResult>('mac.listDir', { path: shared })
    expect(dir.entries.map((e) => `${e.name}:${e.kind}`)).toEqual([
      'bin.dat:file',
      'link-out:link',
      'notes.md:file'
    ])
    expect(
      (await b.call<MacReadFileResult>('mac.readFile', { path: join(managed, 'README.md') }))
        .content
    ).toBe('managed')
    const fetched = await b.call<MacFetchFileWire>('mac.fetchFile', {
      path: join(shared, 'notes.md')
    })
    expect(Buffer.from(fetched.dataBase64, 'base64').toString()).toBe('shared notes')
    expect(b.requests()).toEqual([])
    expect(b.lines.every((l) => !l.includes('shared notes'))).toBe(true)
    expect(b.lines.filter((l) => l.includes('allowed (shared)')).length).toBe(5)
  })

  it("read: ~ is the Mac's home; relative and ~user paths are refused", async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read')
    b.mb.setShared('env_box', [shared])
    expect(
      (await b.call<MacReadFileResult>('mac.readFile', { path: '~/Documents/shared/notes.md' }))
        .content
    ).toBe('shared notes')
    await expect(b.call('mac.readFile', { path: 'x' })).rejects.toThrow(/absolute/)
    await expect(b.call('mac.readFile', { path: '~root/x' })).rejects.toThrow(/absolute/)
    expect(b.requests()).toEqual([])
  })

  it("peer.register names this Mac's home for the box threads' tool text", async () => {
    const sent: { method: string; params: unknown }[] = []
    const mb = new MacBridge({
      environmentId: 'env_mac',
      store: { getSetting: () => null, setSetting: () => {} },
      managedRoots: () => [],
      environments: () => [{ id: 'env_box', name: 'box' }],
      link: () => async (method: string, params: unknown) => {
        sent.push({ method, params })
        return { environmentId: 'env_box' }
      },
      home,
      log: () => {}
    })
    await mb.linkUp('env_box')
    expect(sent).toEqual([
      { method: 'peer.register', params: { from: 'env_mac', offers: ['mac-bridge'], home } }
    ])
  })

  it('peer.register names the host, its build and its presence for the relay, with the relay offer', async () => {
    const sent: { method: string; params: unknown }[] = []
    const build = { release: 300, version: '1.0.300', sha: 'abc', platform: 'darwin' }
    const presence = { screen: 'locked' as const, power: 'awake' as const, at: 5 }
    const mb = new MacBridge({
      environmentId: 'env_mac',
      store: { getSetting: () => null, setSetting: () => {} },
      managedRoots: () => [],
      environments: () => [{ id: 'env_box', name: 'box' }],
      link: () => async (method: string, params: unknown) => {
        sent.push({ method, params })
        return { environmentId: 'env_box' }
      },
      home,
      offers: () => ['relay'],
      registration: () => ({ name: 'Studio', presence, build }),
      log: () => {}
    })
    await mb.linkUp('env_box')
    expect(sent).toEqual([
      { method: 'peer.register', params: { from: 'env_mac', offers: ['mac-bridge', 'relay'], home, name: 'Studio', presence, build } }
    ])
  })

  it('a path that does not exist is decided before anything is read: off refuses, read asks, a denial never says ENOENT', async () => {
    const ghost = join(root, 'Users', 'someone-else', 'Desktop')
    const b = bridge()
    await expect(b.call('mac.listDir', { path: ghost })).rejects.toThrow(/off for this host/)
    b.mb.setPolicy('env_box', 'read')
    for (const method of ['mac.listDir', 'mac.readFile', 'mac.fetchFile'] as const) {
      const beforeR = b.requests().length
      const denied = b.call(method, { path: ghost })
      const r = await b.nextRequest(beforeR)
      expect(r).toMatchObject({ kind: 'read', method, path: ghost, status: 'pending' })
      b.mb.decide(r.id, false)
      const err = await denied.catch((e: Error) => e)
      expect(String(err)).toMatch(/denied at the Mac/)
      expect(String(err)).not.toMatch(/ENOENT|no such file/)
    }
    // Only once the person allows does the Mac look, and only then can the answer be ENOENT.
    const beforeR = b.requests().length
    const allowed = b.call('mac.listDir', { path: ghost })
    const r = await b.nextRequest(beforeR)
    b.mb.decide(r.id, true)
    await expect(allowed).rejects.toThrow(/ENOENT/)
    // read+run: the same.
    b.mb.setPolicy('env_box', 'read+run')
    const beforeR2 = b.requests().length
    const again = b.call('mac.listDir', { path: ghost }, 's2')
    const r2 = await b.nextRequest(beforeR2)
    expect(r2.path).toBe(ghost)
    b.mb.decide(r2.id, false)
    await expect(again).rejects.toThrow('denied at the Mac')
  })

  it('read and read+run: a folder above home (/Users) asks and is never offered as a remembered folder', async () => {
    for (const policy of ['read', 'read+run'] as const) {
      const b = bridge()
      b.mb.setPolicy('env_box', policy)
      b.mb.setShared('env_box', [shared])
      const listing = b.call<MacListDirResult>('mac.listDir', { path: join(root, 'Users') })
      const r = await b.nextRequest()
      expect(r).toMatchObject({ kind: 'read', path: join(root, 'Users') })
      expect(r.folder).toBeUndefined()
      b.mb.decide(r.id, true, true)
      expect((await listing).entries.map((e) => e.name)).toEqual(['me'])
      // Not remembered: the next listing asks again.
      const again = b.call('mac.listDir', { path: join(root, 'Users') })
      const r2 = await b.nextRequest(1)
      b.mb.decide(r2.id, false)
      await expect(again).rejects.toThrow('denied')
      // And a read outside the shared folder still asks, as before.
      const outside = b.call('mac.readFile', { path: join(elsewhere, 'secret.txt') })
      const r3 = await b.nextRequest(2)
      b.mb.decide(r3.id, false)
      await expect(outside).rejects.toThrow('denied')
    }
  })

  it('read outside: asks; a denial is an error; allow + remember admits the folder for that thread only', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read')
    b.mb.setShared('env_box', [shared])
    const denied = b.call('mac.readFile', { path: join(elsewhere, 'secret.txt') })
    const r1 = await b.nextRequest()
    expect(r1).toMatchObject({
      kind: 'read',
      method: 'mac.readFile',
      path: join(elsewhere, 'secret.txt'),
      folder: elsewhere,
      hostName: 'box',
      sessionId: 's1',
      threadTitle: 'thread s1',
      status: 'pending'
    })
    expect(b.mb.pending().map((r) => r.id)).toEqual([r1.id])
    b.mb.decide(r1.id, false)
    await expect(denied).rejects.toThrow('denied at the Mac')
    expect(b.pushes).toContainEqual({ push: 'macBridge.resolved', id: r1.id, outcome: 'denied' })
    expect(b.mb.pending()).toEqual([])

    const allowed = b.call<MacReadFileResult>('mac.readFile', {
      path: join(elsewhere, 'secret.txt')
    })
    const r2 = await b.nextRequest(1)
    b.mb.decide(r2.id, true, true)
    expect((await allowed).content).toBe('private')
    // Remembered: the same folder (and below) for s1 goes through.
    expect(
      (
        await b.call<MacReadFileResult>('mac.readFile', {
          path: join(elsewhere, 'sub', 'deep.txt')
        })
      ).content
    ).toBe('deep')
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

  it("an unanswered request expires within the box's deadline", async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read')
    await expect(b.call('mac.listDir', { path: elsewhere }, 's1', 3_100)).rejects.toThrow(
      /nobody at the Mac answered/
    )
    expect(b.pushes.at(-1)).toMatchObject({ push: 'macBridge.resolved', outcome: 'expired' })
  })
})

describe('MacBridge full access', () => {
  it('reads, lists and fetches outside every shared folder without asking, ~ included', async () => {
    const b = bridge({ managed: [] })
    b.mb.setPolicy('env_box', 'full')
    expect(b.mb.policyOf('env_box')).toBe('full')
    expect(
      (await b.call<MacReadFileResult>('mac.readFile', { path: join(elsewhere, 'secret.txt') }))
        .content
    ).toBe('private')
    expect(
      (await b.call<MacReadFileResult>('mac.readFile', { path: join(home, 'top.txt') })).content
    ).toBe('at home')
    expect(
      (await b.call<MacReadFileResult>('mac.readFile', { path: '~/Private/sub/deep.txt' })).content
    ).toBe('deep')
    const listing = await b.call<MacListDirResult>('mac.listDir', { path: home })
    expect(listing.entries.map((e) => e.name)).toContain('Private')
    const fetched = await b.call<MacFetchFileWire>('mac.fetchFile', {
      path: join(elsewhere, 'sub', 'deep.txt')
    })
    expect(Buffer.from(fetched.dataBase64, 'base64').toString()).toBe('deep')
    // A symlink out of a shared folder into a readable place reads too.
    expect(
      (await b.call<MacReadFileResult>('mac.readFile', { path: join(shared, 'link-out') })).content
    ).toBe('private')
    expect(b.requests()).toEqual([])
    expect(b.lines.filter((l) => l.includes('allowed (full)')).length).toBe(6)
  })

  it('a path that does not exist answers ENOENT at once: full access already admits it', async () => {
    const b = bridge({ managed: [] })
    b.mb.setPolicy('env_box', 'full')
    await expect(b.call('mac.listDir', { path: join(home, 'Nope') })).rejects.toThrow(/ENOENT/)
    expect(b.requests()).toEqual([])
  })

  it('every deny-list path still asks, each time, with no folder to remember', async () => {
    const b = bridge({ managed: [] })
    b.mb.setPolicy('env_box', 'full')
    const paths = [
      ...FULL_DENY_DIRS.map((d) => join(home, d, 'inside')),
      ...FULL_DENY_FILES.map((f) => join(home, f)),
      join(elsewhere, 'server.pem'),
      join(elsewhere, 'settings.local.json')
    ]
    for (const path of paths) {
      const beforeR = b.requests().length
      const asked = b.call('mac.readFile', { path })
      const r = await b.nextRequest(beforeR)
      expect(r).toMatchObject({ kind: 'read', path })
      expect(r.folder).toBeUndefined()
      b.mb.decide(r.id, false)
      await expect(asked).rejects.toThrow('denied at the Mac')
    }
    // Listing a deny-list folder asks too.
    const beforeRL = b.requests().length
    const listing = b.call('mac.listDir', { path: join(home, '.ssh') })
    const rl = await b.nextRequest(beforeRL)
    b.mb.decide(rl.id, false)
    await expect(listing).rejects.toThrow('denied')
    // Allowed once with remember: read once, and the next read asks again.
    const beforeR1 = b.requests().length
    const once = b.call<MacReadFileResult>('mac.readFile', { path: join(home, '.ssh', 'inside') })
    const r1 = await b.nextRequest(beforeR1)
    b.mb.decide(r1.id, true, true)
    expect((await once).content).toBe('key material')
    const beforeR2 = b.requests().length
    const twice = b.call('mac.readFile', { path: join(home, '.ssh', 'inside') })
    const r2 = await b.nextRequest(beforeR2)
    b.mb.decide(r2.id, false)
    await expect(twice).rejects.toThrow('denied')
    expect(b.lines.every((l) => !l.includes('key material'))).toBe(true)
  })

  it('a symlink into a deny-list folder asks, by where it points', async () => {
    const b = bridge({ managed: [] })
    b.mb.setPolicy('env_box', 'full')
    const viaFile = b.call('mac.readFile', { path: join(elsewhere, 'looks-harmless') })
    const r1 = await b.nextRequest()
    expect(r1.path).toBe(join(home, '.ssh', 'inside'))
    b.mb.decide(r1.id, false)
    await expect(viaFile).rejects.toThrow('denied')
    const viaDir = b.call('mac.readFile', { path: join(elsewhere, 'cloud', 'inside') })
    const r2 = await b.nextRequest(1)
    expect(r2.path).toBe(join(home, '.aws', 'inside'))
    b.mb.decide(r2.id, false)
    await expect(viaDir).rejects.toThrow('denied')
  })

  it('a folder above home (/Users, /) asks; home itself does not', async () => {
    const b = bridge({ managed: [] })
    b.mb.setPolicy('env_box', 'full')
    const users = b.call('mac.listDir', { path: join(root, 'Users') })
    const r1 = await b.nextRequest()
    expect(r1).toMatchObject({ kind: 'read', path: join(root, 'Users') })
    expect(r1.folder).toBeUndefined()
    b.mb.decide(r1.id, false)
    await expect(users).rejects.toThrow('denied')
    const disk = b.call('mac.listDir', { path: '/' })
    const r2 = await b.nextRequest(1)
    expect(r2.path).toBe('/')
    b.mb.decide(r2.id, false)
    await expect(disk).rejects.toThrow('denied')
    await b.call<MacListDirResult>('mac.listDir', { path: '~' })
    expect(b.requests().length).toBe(2)
  })

  it('commands still ask every time, with the same exact-command remember as read+run', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'full')
    const first = b.call<MacRunResult>('mac.run', { argv: ['/bin/echo', 'full'], cwd: '~' })
    const r1 = await b.nextRequest()
    expect(r1).toMatchObject({ kind: 'run', argv: ['/bin/echo', 'full'], cwd: home })
    b.mb.decide(r1.id, true, true)
    expect((await first).stdout).toBe('full\n')
    const second = await b.call<MacRunResult>('mac.run', { argv: ['/bin/echo', 'full'], cwd: home })
    expect(second.stdout).toBe('full\n')
    expect(b.requests().at(-1)?.status).toBe('running')
    const other = b.call('mac.run', { argv: ['/bin/echo', 'other'], cwd: home })
    const r3 = await b.nextRequest(b.requests().length - 1)
    expect(r3).toMatchObject({ kind: 'run', argv: ['/bin/echo', 'other'], status: 'pending' })
    b.mb.decide(r3.id, false)
    await expect(other).rejects.toThrow('denied')
    expect(b.lines.some((l) => l.includes('mac.run → allowed (remembered, quiet) argv0=echo'))).toBe(true)
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
    expect(r1).toMatchObject({
      kind: 'run',
      method: 'mac.run',
      argv: ['/bin/echo', 'hello mac'],
      cwd: shared,
      status: 'pending',
      timeoutMs: 120_000
    })
    b.mb.decide(r1.id, true, true)
    const out = await first
    expect(out).toMatchObject({
      exitCode: 0,
      stdout: 'hello mac\n',
      timedOut: false,
      truncated: false
    })
    expect(b.pushes).toContainEqual({ push: 'macBridge.resolved', id: r1.id, outcome: 'done' })
    // The same argv and cwd: runs at once, still shown on the Mac as running.
    const second = await b.call<MacRunResult>('mac.run', {
      argv: ['/bin/echo', 'hello mac'],
      cwd: shared
    })
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

  it('a full-access thread (permission auto) runs and reads without asking; the policy still rules', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read+run')
    const ctx = { from: 'env_box', deadlineAt: Date.now() + 15 * 60_000 }
    const thread = { id: 's9', title: 'auto thread', permission: 'auto' }
    const out = (await b.mb.handle(
      'mac.run',
      { thread, args: { argv: ['/bin/echo', 'unattended'], cwd: elsewhere } },
      ctx
    )) as MacRunResult
    expect(out.stdout).toBe('unattended\n')
    // The card still shows on the Mac: pending for a tick, then running, never waited on.
    const shown = b.requests().filter((r) => r.kind === 'run')
    expect(shown.map((r) => r.status)).toEqual(['pending', 'running'])
    expect(b.lines.some((l) => l.includes('mac.run → allowed (full access)'))).toBe(true)
    // A path outside every root: no prompt either.
    await b.mb.handle('mac.listDir', { thread, args: { path: elsewhere } }, ctx)
    expect(b.requests().filter((r) => r.kind === 'read')).toEqual([])
    expect(b.lines.some((l) => l.includes('mac.listDir → allowed (full access)'))).toBe(true)
    // An ordinary thread on the same host still asks.
    const asked = b.call('mac.listDir', { path: elsewhere }, 's1')
    const r = await b.nextRequest(b.requests().length - 1)
    expect(r.kind).toBe('read')
    b.mb.decide(r.id, false)
    await expect(asked).rejects.toThrow('denied')
    // The per-box policy outranks the thread: read refuses commands, off refuses everything.
    b.mb.setPolicy('env_box', 'read')
    await expect(
      b.mb.handle('mac.run', { thread, args: { argv: ['/bin/echo'], cwd: elsewhere } }, ctx)
    ).rejects.toThrow(/may read on the Mac but not run/)
    b.mb.setPolicy('env_box', 'off')
    await expect(b.mb.handle('mac.listDir', { thread, args: { path: elsewhere } }, ctx)).rejects.toThrow(/bridge is off/)
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
    expect(b.pushes.at(-1)).toMatchObject({
      push: 'macBridge.resolved',
      id: r1.id,
      outcome: 'stopped'
    })
  })

  it('the timeout is enforced on the Mac', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read+run')
    const run = b.call<MacRunResult>('mac.run', {
      command: 'sleep 30',
      cwd: shared,
      timeoutMs: 1_000
    })
    b.mb.decide((await b.nextRequest()).id, true)
    const result = await run
    expect(result.timedOut).toBe(true)
  })

  it('argv xor command; a missing cwd is refused', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read+run')
    await expect(b.call('mac.run', { argv: ['a'], command: 'a' })).rejects.toThrow(/one of them/)
    await expect(b.call('mac.run', {})).rejects.toThrow(/one of them/)
    await expect(b.call('mac.run', { argv: ['ls'], cwd: join(home, 'nope') })).rejects.toThrow(
      /no such folder/
    )
  })

  it('the command key is argv or command, and cwd', () => {
    expect(commandKey({ argv: ['a', 'b'], cwd: '/x' })).not.toBe(
      commandKey({ command: 'a b', cwd: '/x' })
    )
    expect(commandKey({ argv: ['a', 'b'], cwd: '/x' })).not.toBe(
      commandKey({ argv: ['a', 'b'], cwd: '/y' })
    )
    expect(commandKey({ argv: ['a b'], cwd: '/x' })).not.toBe(
      commandKey({ argv: ['a', 'b'], cwd: '/x' })
    )
  })
})

describe('runPresentation', () => {
  it('a command nothing admits prompts, and a prompt always shows', () => {
    expect(runPresentation({ remembered: false, unattended: false, showRunning: false })).toEqual({
      prompt: true
    })
    expect(runPresentation({ remembered: false, unattended: false, showRunning: true })).toEqual({
      prompt: true
    })
  })
  it('a remembered command, or one from a full-access thread, starts at once and is quiet unless the host shows running commands', () => {
    expect(runPresentation({ remembered: true, unattended: false, showRunning: false })).toEqual({
      prompt: false,
      why: 'remembered',
      quiet: true
    })
    expect(runPresentation({ remembered: false, unattended: true, showRunning: false })).toEqual({
      prompt: false,
      why: 'full access',
      quiet: true
    })
    expect(runPresentation({ remembered: true, unattended: true, showRunning: true })).toEqual({
      prompt: false,
      why: 'remembered',
      quiet: false
    })
  })
  it('the default is off under full access, on otherwise', () => {
    expect(showRunningDefault('full')).toBe(false)
    expect(showRunningDefault('read+run')).toBe(true)
    expect(showRunningDefault('read')).toBe(true)
    expect(showRunningDefault('off')).toBe(true)
  })
})

describe('MacBridge quiet commands', () => {
  it('"show running commands" follows the policy until pinned, and the pin survives a policy change', () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read+run')
    expect(b.mb.showRunningOf('env_box')).toBe(true)
    b.mb.setPolicy('env_box', 'full')
    expect(b.mb.hosts()[0]).toMatchObject({ policy: 'full', showRunning: false })
    b.mb.setShowRunning('env_box', true)
    expect(b.settings.get('macBridge.showRunning.env_box')).toBe('on')
    expect(b.mb.hosts()[0].showRunning).toBe(true)
    b.mb.setPolicy('env_box', 'read+run')
    b.mb.setShowRunning('env_box', false)
    expect(b.mb.hosts()[0]).toMatchObject({ policy: 'read+run', showRunning: false })
    expect(() => b.mb.setShowRunning('env_nobody', true)).toThrow(/unknown host/)
  })

  it('under full access a full-access thread runs with no card: the request is quiet, listed, and still stops', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'full')
    const ctx = { from: 'env_box', deadlineAt: Date.now() + 15 * 60_000 }
    const thread = { id: 's9', title: 'auto thread', permission: 'auto' }
    const run = b.mb.handle(
      'mac.run',
      { thread, args: { command: 'sleep 30', cwd: elsewhere } },
      ctx
    ) as Promise<MacRunResult>
    const shown = await b.nextRequest(1)
    expect(shown).toMatchObject({ kind: 'run', status: 'running', quiet: true })
    expect(b.requests().every((r) => r.quiet === true)).toBe(true)
    // Listed for the Remote access pane, with Stop, which kills it.
    expect(b.mb.pending().map((r) => [r.status, r.quiet])).toEqual([['running', true]])
    b.mb.decide(shown.id, false)
    const result = await run
    expect(result.exitCode === 0).toBe(false)
    expect(b.pushes.at(-1)).toMatchObject({ push: 'macBridge.resolved', id: shown.id, outcome: 'stopped' })
    expect(b.lines.some((l) => l.includes('mac.run → allowed (full access, quiet) argv0=sleep'))).toBe(true)
    // A command nothing admits still prompts under full access for an ordinary thread, and a prompt is never quiet.
    const asked = b.call('mac.run', { argv: ['/bin/echo', 'x'], cwd: elsewhere }, 's1')
    const r = await b.nextRequest(b.requests().length - 1)
    expect(r).toMatchObject({ status: 'pending', sessionId: 's1' })
    expect(r.quiet).toBeUndefined()
    b.mb.decide(r.id, false)
    await expect(asked).rejects.toThrow('denied')
  })

  it('with "show running commands" on, the same call shows as a running card; a remembered command under read+run shows by default', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'full')
    b.mb.setShowRunning('env_box', true)
    const ctx = { from: 'env_box', deadlineAt: Date.now() + 15 * 60_000 }
    const thread = { id: 's9', title: 'auto thread', permission: 'auto' }
    await b.mb.handle('mac.run', { thread, args: { argv: ['/bin/echo', 'shown'], cwd: elsewhere } }, ctx)
    expect(b.requests().map((r) => [r.status, r.quiet])).toEqual([
      ['pending', undefined],
      ['running', undefined]
    ])
    expect(b.lines.some((l) => l.includes('mac.run → allowed (full access) argv0=echo'))).toBe(true)
    // read+run keeps its default: a remembered command shows.
    b.mb.setPolicy('env_box', 'read+run')
    b.settings.delete('macBridge.showRunning.env_box')
    const first = b.call<MacRunResult>('mac.run', { argv: ['/bin/echo', 'twice'], cwd: shared })
    const r1 = await b.nextRequest(b.requests().length - 1)
    b.mb.decide(r1.id, true, true)
    await first
    await b.call<MacRunResult>('mac.run', { argv: ['/bin/echo', 'twice'], cwd: shared })
    const again = b.requests().filter((r) => r.argv?.[1] === 'twice')
    expect(again.at(-1)).toMatchObject({ status: 'running' })
    expect(again.every((r) => r.quiet === undefined)).toBe(true)
    // Pinned off there: quiet.
    b.mb.setShowRunning('env_box', false)
    await b.call<MacRunResult>('mac.run', { argv: ['/bin/echo', 'twice'], cwd: shared })
    expect(b.requests().at(-1)).toMatchObject({ status: 'running', quiet: true })
  })

  it('reads and writes a full-access thread is admitted never make a request at all', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'full')
    const ctx = { from: 'env_box', deadlineAt: Date.now() + 15 * 60_000 }
    const thread = { id: 's9', title: 'auto thread', permission: 'auto' }
    await b.mb.handle('mac.readFile', { thread, args: { path: join(elsewhere, 'secret.txt') } }, ctx)
    await b.mb.handle('mac.listDir', { thread, args: { path: join(home, '.ssh') } }, ctx)
    expect(b.requests()).toEqual([])
    expect(b.mb.pending()).toEqual([])
  })
})

describe('MacBridge load guard', () => {
  const ctx = () => ({ from: 'env_box', deadlineAt: Date.now() + 15 * 60_000 })
  const auto = (id: string) => ({ id, title: `auto ${id}`, permission: 'auto' })

  it('the host row carries the caps and the counts; limits.set pins and clears them, refusing nonsense', () => {
    const b = bridge()
    expect(b.mb.hosts()[0]).toMatchObject({ maxRunning: 4, maxThreads: 2, running: 0, held: 0, threads: 0 })
    expect(b.mb.setLimits('env_box', { maxRunning: 1, maxThreads: 0 })[0]).toMatchObject({ maxRunning: 1, maxThreads: 0 })
    expect(b.settings.get('macBridge.maxRunning.env_box')).toBe('1')
    expect(b.mb.setLimits('env_box', { maxRunning: null })[0]).toMatchObject({ maxRunning: 4, maxThreads: 0 })
    expect(() => b.mb.setLimits('env_box', { maxRunning: 0 })).toThrow(/running: a whole number/)
    expect(() => b.mb.setLimits('env_box', { maxThreads: 1.5 })).toThrow(/threads: a whole number/)
    expect(() => b.mb.setLimits('env_other', { maxRunning: 2 })).toThrow(/unknown host/)
    // A garbage setting falls back to the default.
    b.settings.set('macBridge.maxRunning.env_box', 'many')
    expect(b.mb.maxRunningOf('env_box')).toBe(4)
    // The load limit follows the cores until pinned.
    expect(b.mb.loadStatus()).toMatchObject({ load: 0, cores: 8, limit: 16, pinned: false, resumeBelow: 12, busy: false })
    expect(b.mb.setLoadLimit(6)).toMatchObject({ limit: 6, pinned: true, resumeBelow: 4.5 })
    expect(() => b.mb.setLoadLimit(0)).toThrow(/above 0/)
    expect(b.mb.setLoadLimit(null)).toMatchObject({ limit: 16, pinned: false })
  })

  it('cap 1: the second command is held, in line, and runs once the first ends; the box only sees a later answer', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'full')
    b.mb.setLimits('env_box', { maxRunning: 1 })
    const first = b.mb.handle('mac.run', { thread: auto('s1'), args: { command: 'sleep 0.6; echo first', cwd: shared } }, ctx()) as Promise<MacRunResult>
    await b.nextRequest(1) // first: running
    const second = b.mb.handle('mac.run', { thread: auto('s2'), args: { command: 'echo second', cwd: shared } }, ctx()) as Promise<MacRunResult>
    const held = await b.nextRequest(3)
    expect(held).toMatchObject({
      sessionId: 's2',
      status: 'held',
      quiet: true,
      held: { reason: 'cap', position: 1, maxRunning: 1, running: 1, cores: 8, limit: 16, load: 0 }
    })
    expect(b.mb.hosts()[0]).toMatchObject({ running: 1, held: 1 })
    expect(b.mb.pending().map((r) => [r.sessionId, r.status])).toEqual([['s1', 'running'], ['s2', 'held']])
    expect(() => b.mb.decide(held.id, true)).toThrow(/already allowed and waiting/)
    expect((await first).stdout).toBe('first\n')
    expect((await second).stdout).toBe('second\n')
    const s2 = b.requests().filter((r) => r.sessionId === 's2').map((r) => r.status)
    expect(s2).toEqual(['pending', 'held', 'running'])
    expect(b.requests().filter((r) => r.sessionId === 's2').at(-1)?.held).toBeUndefined()
    expect(b.lines.some((l) => l.includes('thread=s2 mac.run → held (1 of 1 running, 1st in line)'))).toBe(true)
    expect(b.lines.some((l) => l.includes('thread=s2 mac.run → released'))).toBe(true)
    expect(b.mb.hosts()[0]).toMatchObject({ running: 0, held: 0 })
  })

  it('held calls go in order; Stop on a held one fails its call as stopped and moves the rest up', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'full')
    b.mb.setLimits('env_box', { maxRunning: 1 })
    const first = b.mb.handle('mac.run', { thread: auto('s1'), args: { command: 'sleep 0.5; echo one', cwd: shared } }, ctx()) as Promise<MacRunResult>
    await b.nextRequest(1)
    const second = b.mb.handle('mac.run', { thread: auto('s2'), args: { command: 'echo two', cwd: shared } }, ctx()) as Promise<MacRunResult>
    const h2 = await b.nextRequest(3)
    const third = b.mb.handle('mac.run', { thread: auto('s3'), args: { command: 'echo three', cwd: shared } }, ctx()) as Promise<MacRunResult>
    const h3 = await b.nextRequest(5)
    expect([h2.held?.position, h3.held?.position]).toEqual([1, 2])
    b.mb.decide(h2.id, false)
    await expect(second).rejects.toThrow(/stopped at the Mac while waiting/)
    expect(b.pushes.some((p) => p.push === 'macBridge.resolved' && p.id === h2.id && p.outcome === 'stopped')).toBe(true)
    const moved = b.requests().filter((r) => r.id === h3.id).at(-1)
    expect(moved?.held?.position).toBe(1)
    expect((await first).stdout).toBe('one\n')
    expect((await third).stdout).toBe('three\n')
  })

  it('over the load limit every new command is held for load and goes once the load is back under 1.5 × cores; reads are never held', async () => {
    const b = bridge({ load: { load: 20, cores: 8 } })
    b.mb.setPolicy('env_box', 'full')
    expect(b.mb.guard.sample().busy).toBe(true)
    const run = b.mb.handle('mac.run', { thread: auto('s1'), args: { command: 'echo calm', cwd: shared } }, ctx()) as Promise<MacRunResult>
    const held = await b.nextRequest(1)
    expect(held).toMatchObject({ status: 'held', held: { reason: 'load', position: 1, load: 20, limit: 16, cores: 8 } })
    expect(b.lines.some((l) => l.includes('mac.run → held (load 20.0 of 16, 1st in line)'))).toBe(true)
    // A read goes through at once, load or not.
    const listed = (await b.mb.handle('mac.listDir', { thread: auto('s1'), args: { path: shared } }, ctx())) as MacListDirResult
    expect(listed.entries.length).toBeGreaterThan(0)
    // Down to 13: under the limit, over the resume line: still held, the figure updated.
    b.sample.load = 13
    expect(b.mb.guard.sample().busy).toBe(true)
    expect(b.requests().at(-1)).toMatchObject({ id: held.id, status: 'held', held: { load: 13 } })
    b.sample.load = 11
    expect(b.mb.guard.sample().busy).toBe(false)
    expect((await run).stdout).toBe('calm\n')
  })

  it('a held command whose call leaves no time waits no longer than that, and the box hears why', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'full')
    b.mb.setLimits('env_box', { maxRunning: 1 })
    const first = b.mb.handle('mac.run', { thread: auto('s1'), args: { command: 'sleep 1.5', cwd: shared } }, ctx()) as Promise<MacRunResult>
    await b.nextRequest(1)
    // deadline = now + 1 s timeout + 3 s margin + 300 ms: the hold has 300 ms.
    const tight = b.mb.handle(
      'mac.run',
      { thread: auto('s2'), args: { command: 'echo late', cwd: shared, timeoutMs: 1_000 } },
      { from: 'env_box', deadlineAt: Date.now() + 1_000 + 3_000 + 300 }
    )
    await expect(tight).rejects.toThrow(/stayed too busy/)
    expect(b.pushes.some((p) => p.push === 'macBridge.resolved' && p.outcome === 'expired')).toBe(true)
    await first
  })

  it('a job waits its turn behind a command too, and frees the slot when it ends', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'full')
    b.mb.setLimits('env_box', { maxRunning: 1 })
    const first = b.mb.handle('mac.run', { thread: auto('s1'), args: { command: 'sleep 0.5', cwd: shared } }, ctx()) as Promise<MacRunResult>
    await b.nextRequest(1)
    const job = b.mb.handle('mac.jobStart', { thread: auto('s1'), args: { argv: ['cat'], cwd: shared } as never }, ctx()) as Promise<{ jobId: string }>
    const held = await b.nextRequest(3)
    expect(held).toMatchObject({ status: 'held', interactive: true, held: { reason: 'cap', position: 1 } })
    await first
    const started = await job
    expect(started.jobId).toMatch(/^job_/)
    expect(b.mb.hosts()[0]).toMatchObject({ running: 1, held: 0 })
    await b.mb.handle('mac.jobSignal', { thread: auto('s1'), args: { jobId: started.jobId, signal: 'KILL' } as never }, ctx())
    for (let i = 0; i < 100 && b.mb.hosts()[0].running > 0; i++) await new Promise((ok) => setTimeout(ok, 10))
    expect(b.mb.hosts()[0]).toMatchObject({ running: 0, held: 0 })
  })

  it('admitThread counts the live threads a host started here against macBridge.maxThreads', () => {
    let live = 0
    const settings = new Map<string, string>()
    const mb = new MacBridge({
      environmentId: 'env_mac',
      store: { getSetting: (k) => settings.get(k) ?? null, setSetting: (k, v) => (v === null ? settings.delete(k) : settings.set(k, v)) },
      managedRoots: () => [],
      environments: () => [{ id: 'env_box', name: 'box' }],
      link: () => null,
      home,
      log: () => {},
      load: { sample: () => ({ load: 0, cores: 8 }), intervalMs: 0 },
      liveThreads: () => live
    })
    expect(mb.admitThread('env_box')).toEqual({ ok: true, live: 0, max: 2 })
    live = 2
    expect(mb.admitThread('env_box')).toMatchObject({ ok: false, live: 2, max: 2, reason: expect.stringContaining('already runs 2 threads from this host, its cap of 2') })
    expect(mb.hosts()[0].threads).toBe(2)
    mb.setLimits('env_box', { maxThreads: 3 })
    expect(mb.admitThread('env_box').ok).toBe(true)
    mb.setLimits('env_box', { maxThreads: 0 })
    expect(mb.admitThread('env_box')).toMatchObject({ ok: false, reason: expect.stringContaining('takes no threads') })
    mb.close()
  })
})

describe('MacBridge: pause and Stop from the box (mac.cancel, mac.held, a paused read)', () => {
  const ctx = (callId: string) => ({ from: 'env_box', deadlineAt: Date.now() + 15 * 60_000, callId })
  const thread = { id: 's1', title: 'thread s1' }

  it('mac.cancel on a waiting card denies it, on a running command kills it: what the Stop button sends', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read+run')
    const waiting = b.mb.handle('mac.run', { thread, args: { argv: ['/bin/echo', 'never'], cwd: shared } }, ctx('c_wait'))
    const running = b.mb.handle('mac.run', { thread, args: { command: 'sleep 30', cwd: shared } }, ctx('c_run'))
    const r1 = await b.nextRequest(0)
    const r2 = await b.nextRequest(1)
    b.mb.decide(r2.id, true)
    await b.nextRequest(2)
    // Another thread's call with the same id shape is not touched; an id not out here is nothing.
    const out = (await b.mb.handle(
      'mac.cancel',
      { thread, args: { callIds: ['c_wait', 'c_run', 'c_nothing'], jobs: true, reason: 'paused' } },
      ctx('c_cancel')
    )) as { cancelled: number; jobsEnded: number }
    expect(out).toEqual({ cancelled: 2, jobsEnded: 0 })
    await expect(waiting).rejects.toThrow('denied at the Mac')
    const result = (await running) as MacRunResult
    expect(result.exitCode === 0).toBe(false)
    expect(b.pushes).toContainEqual({ push: 'macBridge.resolved', id: r1.id, outcome: 'denied' })
    expect(b.pushes).toContainEqual({ push: 'macBridge.resolved', id: r2.id, outcome: 'stopped' })
    expect(b.lines.some((l) => l.includes('mac.cancel → paused: 2 cancelled, 0 job(s) ended'))).toBe(true)
    expect(b.mb.pending()).toEqual([])
  })

  it('mac.cancel needs no policy: with the bridge off it still answers', async () => {
    const b = bridge()
    const out = await b.mb.handle('mac.cancel', { thread, args: { callIds: [], reason: 'stopped' } }, ctx('c'))
    expect(out).toEqual({ cancelled: 0, jobsEnded: 0 })
  })

  it("mac.held lists a paused thread's calls as paused rows: in pending(), nothing to decide, gone when the set shrinks or the link drops", async () => {
    const b = bridge()
    const held = (list: unknown[]) =>
      b.mb.handle('mac.held', { thread, args: { held: list } } as never, ctx('c_held'))
    await held([
      { id: 'h1', method: 'mac.run', argv: ['make'], cwd: shared, since: 1_000 },
      { id: 'h2', method: 'mac.jobStart', command: 'cat', cwd: shared, since: 2_000 },
      { id: 'h3', method: 'mac.writeFile', path: join(shared, 'x'), bytes: 12, since: 3_000 }
    ])
    const rows = b.mb.pending()
    expect(rows.map((r) => [r.id, r.status, r.kind, r.method])).toEqual([
      ['mb_held_h1', 'paused', 'run', 'mac.run'],
      ['mb_held_h2', 'paused', 'run', 'mac.run'],
      ['mb_held_h3', 'paused', 'write', 'mac.writeFile']
    ])
    expect(rows[1]).toMatchObject({ interactive: true, command: 'cat', createdAt: 2_000 })
    expect(rows[2]).toMatchObject({ bytes: 12, sessionId: 's1', hostName: 'box' })
    expect(() => b.mb.decide('mb_held_h1', false)).toThrow(/paused/)
    expect(b.requests().filter((r) => r.status === 'paused').length).toBe(3)
    // The box released or refused two: the same list again adds no row.
    await held([{ id: 'h2', method: 'mac.jobStart', command: 'cat', cwd: shared, since: 2_000 }])
    expect(b.mb.pending().map((r) => r.id)).toEqual(['mb_held_h2'])
    expect(b.pushes.filter((p) => p.push === 'macBridge.resolved').map((p) => (p as { id: string }).id)).toEqual([
      'mb_held_h1',
      'mb_held_h3'
    ])
    expect(b.requests().length).toBe(3)
    b.mb.linkDown('env_box')
    expect(b.mb.pending()).toEqual([])
  })

  it('a read from a paused thread goes through where it needs no prompt and is refused where it would have asked, with no card', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read')
    b.mb.setShared('env_box', [shared])
    const paused = { ...thread, paused: true as const }
    const listing = (await b.mb.handle('mac.listDir', { thread: paused, args: { path: shared } }, ctx('c1'))) as MacListDirResult
    expect(listing.entries.some((e) => e.name === 'notes.md')).toBe(true)
    await expect(b.mb.handle('mac.readFile', { thread: paused, args: { path: join(elsewhere, 'secret.txt') } }, ctx('c2'))).rejects.toThrow(
      'refused: the thread is paused'
    )
    expect(b.requests()).toEqual([])
    expect(b.lines.some((l) => l.includes('mac.readFile → refused (paused)'))).toBe(true)
    // The box never sends these while paused; one that arrives marked is refused all the same.
    b.mb.setPolicy('env_box', 'full')
    await expect(b.mb.handle('mac.run', { thread: paused, args: { argv: ['/bin/echo'], cwd: shared } }, ctx('c3'))).rejects.toThrow(
      'refused: the thread is paused'
    )
  })
})
