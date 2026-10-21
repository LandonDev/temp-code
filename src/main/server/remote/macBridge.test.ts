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

function bridge(opts: { managed?: string[] } = {}) {
  const settings = new Map<string, string>()
  const pushes: MacBridgePush[] = []
  const lines: string[] = []
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
    log: (l) => lines.push(l)
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
  return { mb, settings, pushes, lines, requests, nextRequest, call }
}

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
        registered: false }
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
