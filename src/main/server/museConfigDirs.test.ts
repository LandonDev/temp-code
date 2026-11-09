import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MUSE_ACCOUNTS,
  MUSE_OWN,
  configureMuseDirs,
  configureMuseSkills,
  migrateMuseDirs,
  museAccountDir,
  museAccountDirs,
  museAccountRoot,
  museConfigDirFor,
  museDirKind,
  museSkillsFor,
  recaptureMuseDir
} from './museConfigDirs'

const blobOf = (email: string, token = 'dca:a') => JSON.stringify({ schema_version: 1, providers: { meta: { access_token: token, api_key: 'LLM|1|k', mechanism: 'oauth', user_email: email } } }, null, 2) + '\n'
const ME = 'landon@example.com'

let base: string
let root: string
let userDir: string
let pointer: string
let blobs: Record<string, string>
let saved: string[]
let logs: string[]

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'muse-dirs-'))
  root = join(base, 'muse-accounts')
  userDir = join(base, 'config', 'muse')
  mkdirSync(join(userDir, 'skills', 'mine'), { recursive: true })
  writeFileSync(join(userDir, 'settings.json'), '{"schema_version":1}')
  mkdirSync(join(userDir, 'hooks'))
  writeFileSync(join(userDir, '.auth.json.lock'), '')
  // The store's scope pointer and its generation.
  pointer = join(base, 'harness', 'muse', 'scope', 'global')
  mkdirSync(join(base, 'harness', 'muse', 'global@aaaaaaaaaaaa', 'skills', 'stored'), { recursive: true })
  mkdirSync(join(base, 'harness', 'muse', 'scope'), { recursive: true })
  symlinkSync(join('..', 'global@aaaaaaaaaaaa'), pointer)
  blobs = { [ME]: blobOf(ME) }
  saved = []
  logs = []
  configureMuseDirs({
    root,
    readBlob: (a) => blobs[a] ?? null,
    saveBlob: (a, b) => {
      saved.push(`${a}:${b}`)
      blobs[a] = b
    },
    accounts: () => Object.keys(blobs),
    userConfigDir: userDir,
    log: (l) => logs.push(l)
  })
})
afterEach(() => {
  configureMuseDirs(null)
  configureMuseSkills(null)
  rmSync(base, { recursive: true, force: true })
})

describe('the store\'s layout', () => {
  it('an account thread gets <root>/accounts/<account>/<scope>, its auth.json the vault\'s 0600, its skills the store\'s, the rest the person\'s', () => {
    const dir = museConfigDirFor(ME, 'global', pointer)!
    expect(dir).toBe(join(root, MUSE_ACCOUNTS, ME, 'global'))
    expect(museDirKind(dir)).toBe('account')
    const auth = join(dir, 'muse', 'auth.json')
    expect(readFileSync(auth, 'utf8')).toBe(blobs[ME])
    expect(statSync(auth).mode & 0o777).toBe(0o600)
    expect(lstatSync(auth).isSymbolicLink()).toBe(false)
    expect(readlinkSync(join(dir, 'muse', 'skills'))).toBe(join(pointer, 'skills'))
    expect(readdirSync(join(dir, 'muse', 'skills'))).toEqual(['stored'])
    expect(readlinkSync(join(dir, 'muse', 'settings.json'))).toBe(join(userDir, 'settings.json'))
    expect(readlinkSync(join(dir, 'muse', 'hooks'))).toBe(join(userDir, 'hooks'))
    expect(existsSync(join(dir, 'muse', '.auth.json.lock'))).toBe(false)
    // Another scope is another dir of the same account.
    expect(museConfigDirFor(ME, 'ws-w1', pointer)).toBe(join(root, MUSE_ACCOUNTS, ME, 'ws-w1'))
    expect(museAccountDirs()).toEqual([ME])
  })

  it('a thread on no account gets <root>/own/<scope>, its auth.json a link to the person\'s only when they have one', () => {
    const dir = museConfigDirFor(null, 'ws-w1', pointer)!
    expect(dir).toBe(join(root, MUSE_OWN, 'ws-w1'))
    expect(museDirKind(dir)).toBe('own')
    expect(() => lstatSync(join(dir, 'muse', 'auth.json'))).toThrow()
    expect(readlinkSync(join(dir, 'muse', 'skills'))).toBe(join(pointer, 'skills'))
    writeFileSync(join(userDir, 'auth.json'), blobOf('live@x'))
    museConfigDirFor(null, 'ws-w1', pointer)
    expect(readlinkSync(join(dir, 'muse', 'auth.json'))).toBe(join(userDir, 'auth.json'))
    rmSync(join(userDir, 'auth.json'))
    museConfigDirFor(null, 'ws-w1', pointer)
    expect(() => lstatSync(join(dir, 'muse', 'auth.json'))).toThrow()
    // An account the vault no longer holds runs on the own dir.
    expect(museConfigDirFor('gone@x', 'global', pointer)).toBe(join(root, MUSE_OWN, 'global'))
  })

  it('no account\'s dir collides with the own dir, whatever it is named', () => {
    blobs.own = blobOf('own')
    blobs.none = blobOf('none')
    const own = museConfigDirFor(null, 'global', pointer)!
    const named = museConfigDirFor('own', 'global', pointer)!
    const none = museConfigDirFor('none', 'global', pointer)!
    expect(new Set([own, named, none]).size).toBe(3)
    expect(readFileSync(join(named, 'muse', 'auth.json'), 'utf8')).toBe(blobs.own)
    expect(() => lstatSync(join(own, 'muse', 'auth.json'))).toThrow()
  })

  it('never links the person\'s skills, and drops a link whose target left', () => {
    const dir = museConfigDirFor(ME, 'global', pointer)!
    rmSync(join(userDir, 'hooks'), { recursive: true })
    museConfigDirFor(ME, 'global', pointer)
    expect(() => lstatSync(join(dir, 'muse', 'hooks'))).toThrow()
    expect(readlinkSync(join(dir, 'muse', 'skills'))).not.toBe(join(userDir, 'skills'))
  })

  it('the driver\'s seam names the scope and its pointer', () => {
    expect(museSkillsFor({ workspaceId: 'w1', projectId: null, cwd: '/x' })).toBeNull()
    configureMuseSkills({ scopeOf: (s) => s.workspaceId, pointers: { path: (_p, ws) => `/p/${ws ?? 'global'}` } })
    expect(museSkillsFor({ workspaceId: 'w1', projectId: null, cwd: '/x' })).toEqual({ scope: 'ws-w1', pointer: '/p/w1' })
    expect(museSkillsFor({ workspaceId: null, projectId: null, cwd: '/x' })).toEqual({ scope: 'global', pointer: '/p/global' })
  })
})

describe('with no store', () => {
  it('the account dir is today\'s, every shared entry linked, and a thread on no account runs on the CLI\'s own', () => {
    expect(museConfigDirFor(null)).toBeNull()
    expect(museConfigDirFor('nobody@x')).toBeNull()
    const dir = museConfigDirFor(ME)!
    expect(dir).toBe(museAccountDir(root, ME))
    expect(museDirKind(dir)).toBeNull()
    expect(readlinkSync(join(dir, 'muse', 'skills'))).toBe(join(userDir, 'skills'))
    const auth = join(dir, 'muse', 'auth.json')
    const before = statSync(auth).mtimeMs
    expect(museConfigDirFor(ME)).toBe(dir)
    expect(statSync(auth).mtimeMs).toBe(before)
    // A rotation there is recaptured against the copy's seed, once.
    expect(recaptureMuseDir(ME)).toBe(false)
    writeFileSync(auth, blobOf(ME, 'dca:rotated'))
    expect(recaptureMuseDir(ME)).toBe(true)
    expect(recaptureMuseDir(ME)).toBe(false)
    expect(blobs[ME]).toBe(blobOf(ME, 'dca:rotated'))
  })
})

describe('recapture', () => {
  const copy = (scope: string): string => join(museAccountRoot(root, ME), scope, 'muse', 'auth.json')
  const rotate = (scope: string, token: string, at: number): void => {
    writeFileSync(copy(scope), blobOf(ME, token))
    utimesSync(copy(scope), at, at)
  }

  it('saves only a copy the CLI rotated (differs from its own seed), the newest when several did; a logout is no rotation', () => {
    museConfigDirFor(ME, 'global', pointer)
    museConfigDirFor(ME, 'ws-w1', pointer)
    expect(recaptureMuseDir(ME)).toBe(false)
    rotate('global', 'dca:old', 1_000)
    rotate('ws-w1', 'dca:new', 2_000)
    expect(recaptureMuseDir(ME)).toBe(true)
    expect(saved).toEqual([`${ME}:${blobOf(ME, 'dca:new')}`])
    // Both were consumed: nothing counts again until another rotation.
    expect(recaptureMuseDir(ME)).toBe(false)
    writeFileSync(copy('global'), '{"schema_version":1,"providers":{}}\n')
    expect(recaptureMuseDir(ME)).toBe(false)
    expect(saved).toHaveLength(1)
  })

  it('across successive recaptures a scope\'s untouched copy is never saved over another\'s rotation', () => {
    museConfigDirFor(ME, 'global', pointer)
    museConfigDirFor(ME, 'ws-w1', pointer)
    rotate('global', 'dca:t1', 1_000)
    expect(recaptureMuseDir(ME)).toBe(true)
    expect(blobs[ME]).toBe(blobOf(ME, 'dca:t1'))
    // ws-w1 still holds the first token, untouched: never saved over T1.
    expect(recaptureMuseDir(ME)).toBe(false)
    expect(blobs[ME]).toBe(blobOf(ME, 'dca:t1'))
  })

  it('A rotates and is saved (T1), B rotates and is saved (T2), B respawns: the next recapture saves nothing and T2 stays', () => {
    museConfigDirFor(ME, 'global', pointer)
    museConfigDirFor(ME, 'ws-w1', pointer)
    rotate('global', 'dca:t1', 1_000)
    expect(recaptureMuseDir(ME)).toBe(true)
    rotate('ws-w1', 'dca:t2', 2_000)
    expect(recaptureMuseDir(ME)).toBe(true)
    expect(blobs[ME]).toBe(blobOf(ME, 'dca:t2'))
    museConfigDirFor(ME, 'ws-w1', pointer)
    expect(recaptureMuseDir(ME)).toBe(false)
    expect(blobs[ME]).toBe(blobOf(ME, 'dca:t2'))
    expect(saved).toHaveLength(2)
    // Global re-seeds from the vault at its next spawn.
    museConfigDirFor(ME, 'global', pointer)
    expect(readFileSync(copy('global'), 'utf8')).toBe(blobOf(ME, 'dca:t2'))
  })
})

describe('migrateMuseDirs', () => {
  it('recaptures each old dir, then removes it, never the person\'s entries it linked', () => {
    configureMuseSkills(null)
    const old = museConfigDirFor(ME)!
    writeFileSync(join(old, 'muse', 'auth.json'), blobOf(ME, 'dca:rotated'))
    // An old dir of an account named like the new layout's own folder.
    blobs.own = blobOf('own')
    const oldOwn = museConfigDirFor('own')!
    expect(oldOwn).toBe(join(root, 'own'))
    // The new layout beside them stays.
    museConfigDirFor(ME, 'global', pointer)
    migrateMuseDirs()
    expect(saved).toEqual([`${ME}:${blobOf(ME, 'dca:rotated')}`])
    expect(existsSync(old)).toBe(false)
    expect(existsSync(join(oldOwn, 'muse'))).toBe(false)
    expect(existsSync(join(root, MUSE_ACCOUNTS, ME, 'global', 'muse', 'auth.json'))).toBe(true)
    expect(readdirSync(join(userDir, 'skills'))).toEqual(['mine'])
    expect(readFileSync(join(userDir, 'settings.json'), 'utf8')).toBe('{"schema_version":1}')
    expect(logs.filter((l) => l.includes('old config dir removed')).length).toBe(2)
  })
})
