import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { isSharedMuseEntry, museAccountDirName } from '@shared/museSettings'
import { scopeKeyOf, type ScopeKey, type SkillPointers } from './skills/pointers'

/**
 * Where a Muse thread's `muse serve` reads its config from: a dir under the
 * app's data handed to the process as `XDG_CONFIG_HOME`
 * (harness/museHost.ts), one per (account, skills scope):
 *
 *   <root>/accounts/<account>/<scope>/muse/   a thread routed to that account
 *   <root>/own/<scope>/muse/                  a thread on the CLI's own login
 *
 * `accounts/` and `own/` are fixed names, so no account's dir can collide
 * with the own dir. An account dir holds `auth.json` written from the
 * vault's copy (0600, by rename, skipped when identical) and the digest of
 * what was written (`.auth-seed`); the own dir links the person's own
 * `auth.json` when there is one. In both, `skills` links the store's folder
 * for the scope through its pointer (skills/pointers.ts), which Muse reads
 * at every call, so a store write reaches a running thread on its next
 * call; every other shared entry of the person's `~/.config/muse`
 * (settings.json, hooks, trust.json) is a link, so their own settings apply
 * everywhere. With no store configured the account dir is the old
 * `<root>/<account>/muse/` with every shared entry linked, the person's
 * skills too, and a thread on no account runs on the CLI's own config.
 *
 * `recapture` reads an account's copies back: the CLI never rewrote one
 * during a turn in the spike, but `muse usage` rotates the access token in
 * place, and a copy that moved on is the one worth keeping.
 */
export interface MuseDirDeps {
  /** `<userData>/muse-accounts`. */
  root: string
  /** The vault's blob for an account of the muse-code service, null when none. */
  readBlob: (account: string) => string | null
  /** Save a blob the CLI rewrote back into the vault. */
  saveBlob?: (account: string, blob: string) => void
  /** The vault's muse-code accounts, to name the old layout's dirs at migration. */
  accounts?: () => string[]
  /** The person's own config dir; `~/.config/muse` by default. */
  userConfigDir?: string
  log?: (line: string) => void
}

export const MUSE_ACCOUNTS = 'accounts'
export const MUSE_OWN = 'own'
const AUTH = 'auth.json'
const SEED = '.auth-seed'

let deps: MuseDirDeps | null = null

export function configureMuseDirs(next: MuseDirDeps | null): void {
  deps = next
}

/** The person's `muse` config dir: `$XDG_CONFIG_HOME/muse`, else `~/.config/muse`. */
export function userMuseConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return join(xdg && xdg.trim() ? xdg : join(homedir(), '.config'), 'muse')
}

/** The old layout's dir of an account (no store): `<root>/<account>`. */
export function museAccountDir(root: string, account: string): string {
  return join(root, museAccountDirName(account))
}

/** Every account's dirs, one per scope, live under this. */
export function museAccountRoot(root: string, account: string): string {
  return join(root, MUSE_ACCOUNTS, museAccountDirName(account))
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const authText = (blob: string): string => (blob.endsWith('\n') ? blob : `${blob}\n`)

/**
 * The config dir for a thread, made or refreshed: the account's dir of the
 * scope when the vault holds the account, else the own dir of the scope.
 * Null with no store and no account (the CLI's own config), or unconfigured.
 */
export function museConfigDirFor(account: string | null, scope: ScopeKey = 'global', skillsPointer: string | null = null): string | null {
  if (!deps) return null
  const blob = account ? deps.readBlob(account) : null
  const userDir = deps.userConfigDir ?? userMuseConfigDir()
  if (skillsPointer === null) {
    // No store: the old account dir, every shared entry linked; nothing for a thread on no account.
    if (!account || !blob) return null
    const dir = museAccountDir(deps.root, account)
    const museDir = join(dir, 'muse')
    mkdirSync(museDir, { recursive: true, mode: 0o700 })
    writeAuth(museDir, blob)
    linkShared(museDir, userDir, null)
    return dir
  }
  const dir = account && blob ? join(museAccountRoot(deps.root, account), scope) : join(deps.root, MUSE_OWN, scope)
  const museDir = join(dir, 'muse')
  mkdirSync(museDir, { recursive: true, mode: 0o700 })
  if (account && blob) writeAuth(museDir, blob)
  else linkOwnAuth(museDir, userDir)
  linkShared(museDir, userDir, join(skillsPointer, 'skills'))
  return dir
}

/** Which kind of dir museConfigDirFor answered under the store's layout: an account's (its login the file there), the own one, or neither (the old layout, the CLI's own). */
export function museDirKind(dir: string | null): 'account' | 'own' | null {
  if (!deps || !dir) return null
  const rel = relative(deps.root, dir).split(sep)
  if (rel[0] === MUSE_ACCOUNTS && rel.length === 3) return 'account'
  if (rel[0] === MUSE_OWN && rel.length === 2) return 'own'
  return null
}

function writeAuth(museDir: string, blob: string): void {
  const path = join(museDir, AUTH)
  const text = authText(blob)
  let same = false
  try {
    const st = lstatSync(path)
    same = !st.isSymbolicLink() && readFileSync(path, 'utf8') === text
    if (st.isSymbolicLink()) unlinkSync(path)
  } catch {
    // absent: written below
  }
  if (!same) {
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, text, { mode: 0o600 })
    renameSync(tmp, path)
  }
  writeSeed(museDir, sha256(text))
}

function writeSeed(museDir: string, digest: string): void {
  const path = join(museDir, SEED)
  try {
    if (readFileSync(path, 'utf8') === digest) return
  } catch {
    // absent
  }
  writeFileSync(path, digest, { mode: 0o600 })
}

/** The own dir's auth.json: a link to the person's, so the CLI's own login and its rotations stay theirs; none when they have none. */
function linkOwnAuth(museDir: string, userDir: string): void {
  const path = join(museDir, AUTH)
  const target = join(userDir, AUTH)
  const st = lstatOrNull(path)
  if (!existsSync(target)) {
    if (st?.isSymbolicLink()) unlinkSync(path)
    return
  }
  if (st?.isSymbolicLink() && readlinkSync(path) === target) return
  if (st) rmSync(path, { force: true })
  symlinkSync(target, path)
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

/** One symlink per shared entry of the real dir (`skills` the store's when given), stale links removed. */
function linkShared(museDir: string, userDir: string, storeSkills: string | null): void {
  const wanted = new Map<string, string>()
  if (existsSync(userDir)) {
    for (const name of readdirSync(userDir)) {
      if (!isSharedMuseEntry(name) || (storeSkills !== null && name === 'skills')) continue
      wanted.set(name, join(userDir, name))
    }
  }
  if (storeSkills !== null) wanted.set('skills', storeSkills)
  for (const [name, target] of wanted) {
    const link = join(museDir, name)
    const st = lstatOrNull(link)
    if (st?.isSymbolicLink() && readlinkSync(link) === target) continue
    if (st) rmSync(link, { recursive: true, force: true })
    symlinkSync(target, link)
  }
  for (const name of readdirSync(museDir)) {
    if (!isSharedMuseEntry(name) || name === SEED || wanted.has(name)) continue
    if (lstatOrNull(join(museDir, name))?.isSymbolicLink()) unlinkSync(join(museDir, name))
  }
}

/** A copy worth saving: it parses and still holds a credential (a logout is not a rotation). */
function holdsCredential(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { providers?: { meta?: { access_token?: unknown; api_key?: unknown } } }
    return !!(parsed.providers?.meta?.access_token || parsed.providers?.meta?.api_key)
  } catch {
    return false
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * An account's copies back into the vault when the CLI changed one: only a
 * scope whose copy differs from its own seed counts (the CLI rotated it
 * there), the newest such copy is saved, and every copy looked at is seeded
 * with what it holds now, so it counts again only after another rotation.
 * Every other scope re-seeds from the vault at its next spawn.
 */
export function recaptureMuseDir(account: string | null): boolean {
  if (!account || !deps?.saveBlob) return false
  const stored = deps.readBlob(account)
  if (!stored) return false
  const candidates: { museDir: string; text: string; mtime: number }[] = []
  const accountRoot = museAccountRoot(deps.root, account)
  let scopes: string[] = []
  try {
    scopes = readdirSync(accountRoot)
  } catch {
    // no scope dirs yet
  }
  for (const scope of scopes) {
    const museDir = join(accountRoot, scope, 'muse')
    const text = readText(join(museDir, AUTH))
    if (text === null || sha256(text) === readText(join(museDir, SEED))) continue
    let mtime = 0
    try {
      mtime = statSync(join(museDir, AUTH)).mtimeMs
    } catch {
      continue
    }
    candidates.push({ museDir, text, mtime })
  }
  // The old layout (no store): against its seed, or the vault for a copy written before seeds.
  const old = join(museAccountDir(deps.root, account), 'muse')
  const oldText = readText(join(old, AUTH))
  const oldSeed = readText(join(old, SEED))
  if (oldText !== null && (oldSeed !== null ? sha256(oldText) !== oldSeed : oldText.trim() !== stored.trim())) {
    try {
      candidates.push({ museDir: old, text: oldText, mtime: statSync(join(old, AUTH)).mtimeMs })
    } catch {
      // gone
    }
  }
  for (const c of candidates) writeSeed(c.museDir, sha256(c.text))
  const best = candidates.filter((c) => holdsCredential(c.text) && c.text.trim() !== stored.trim()).sort((a, b) => b.mtime - a.mtime)[0]
  if (!best) return false
  deps.saveBlob(account, best.text)
  deps.log?.(`[muse] account ${account}: auth.json changed on disk; saved back to the vault`)
  return true
}

/** The account dirs under the new layout (one per account, each holding a dir per scope). */
export function museAccountDirs(): string[] {
  if (!deps) return []
  try {
    return readdirSync(join(deps.root, MUSE_ACCOUNTS))
  } catch {
    return []
  }
}

/** Boot: each old `<root>/<account>/muse/` dir is recaptured into the vault, then removed. */
export function migrateMuseDirs(): void {
  if (!deps || !existsSync(deps.root)) return
  const byDir = new Map((deps.accounts?.() ?? []).map((a) => [museAccountDirName(a), a]))
  for (const name of readdirSync(deps.root)) {
    const museDir = join(deps.root, name, 'muse')
    if (!lstatOrNull(museDir)?.isDirectory()) continue
    const account = byDir.get(name)
    const text = readText(join(museDir, AUTH))
    const stored = account ? deps.readBlob(account) : null
    if (account && text !== null && stored && text.trim() !== stored.trim() && holdsCredential(text) && deps.saveBlob) {
      deps.saveBlob(account, text)
      deps.log?.(`[muse] account ${account}: auth.json changed on disk; saved back to the vault`)
    }
    // Links are removed, never followed: nothing of the person's goes.
    rmSync(name === MUSE_ACCOUNTS || name === MUSE_OWN ? museDir : join(deps.root, name), { recursive: true, force: true })
    deps.log?.(`[muse] ${name}: the old config dir removed (one per account and scope now)`)
  }
}

// ── the driver's seam ───────────────────────────────────────────────────

export interface MuseSkillsConfig {
  /** The workspace a thread reads skills for (views.ts workspaceOfThread of the thread itself). */
  scopeOf: (session: { workspaceId: string | null; projectId: string | null; cwd: string }) => string | null
  pointers: Pick<SkillPointers, 'path'>
}

let skills: MuseSkillsConfig | null = null

export function configureMuseSkills(cfg: MuseSkillsConfig | null): void {
  skills = cfg
}

/** A Muse thread's skills scope and the pointer its `skills` links; null with no store. */
export function museSkillsFor(session: { workspaceId: string | null; projectId: string | null; cwd: string }): { scope: ScopeKey; pointer: string } | null {
  if (!skills) return null
  const workspaceId = skills.scopeOf(session)
  return { scope: scopeKeyOf(workspaceId), pointer: skills.pointers.path('muse', workspaceId) }
}
