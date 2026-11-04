import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isSharedMuseEntry, museAccountDirName } from '@shared/museSettings'

/**
 * Where a Muse thread's `muse serve` reads its login from: one config dir
 * per account under the app's data, handed to the process as
 * `XDG_CONFIG_HOME` (harness/museHost.ts). The dir holds `muse/auth.json`
 * written from the vault's copy of the account (0600, by rename, skipped when
 * identical) and a symlink per other entry of the person's real
 * `~/.config/muse` (settings.json, skills, hooks, trust.json), so their own
 * settings apply to every account and an edit reaches all of them. A thread
 * routed to no account runs on the CLI's own config (null here).
 *
 * `recapture` reads a dir's auth.json back: the CLI never rewrote it during
 * a turn in the spike, but `muse usage` rotates the access token in place,
 * and a copy that moved on is the one worth keeping.
 */
export interface MuseDirDeps {
  /** `<userData>/muse-accounts`. */
  root: string
  /** The vault's blob for an account of the muse-code service, null when none. */
  readBlob: (account: string) => string | null
  /** Save a blob the CLI rewrote back into the vault. */
  saveBlob?: (account: string, blob: string) => void
  /** The person's own config dir; `~/.config/muse` by default. */
  userConfigDir?: string
  log?: (line: string) => void
}

let deps: MuseDirDeps | null = null

export function configureMuseDirs(next: MuseDirDeps | null): void {
  deps = next
}

/** The person's `muse` config dir: `$XDG_CONFIG_HOME/muse`, else `~/.config/muse`. */
export function userMuseConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return join(xdg && xdg.trim() ? xdg : join(homedir(), '.config'), 'muse')
}

export function museAccountDir(root: string, account: string): string {
  return join(root, museAccountDirName(account))
}

/** The config dir for an account, made or refreshed from the vault; null = the CLI's own. */
export function museConfigDirFor(account: string | null): string | null {
  if (!account || !deps) return null
  const blob = deps.readBlob(account)
  if (!blob) return null
  const dir = museAccountDir(deps.root, account)
  const museDir = join(dir, 'muse')
  mkdirSync(museDir, { recursive: true, mode: 0o700 })
  writeAuth(join(museDir, 'auth.json'), blob)
  linkShared(museDir, deps.userConfigDir ?? userMuseConfigDir())
  return dir
}

function writeAuth(path: string, blob: string): void {
  const text = blob.endsWith('\n') ? blob : `${blob}\n`
  try {
    if (readFileSync(path, 'utf8') === text) return
  } catch {
    // absent: written below
  }
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
}

/** One symlink per shared entry of the real dir, stale links removed. */
function linkShared(museDir: string, userDir: string): void {
  const wanted = new Set<string>()
  if (existsSync(userDir)) {
    for (const name of readdirSync(userDir)) {
      if (!isSharedMuseEntry(name)) continue
      wanted.add(name)
      const target = join(userDir, name)
      const link = join(museDir, name)
      try {
        const st = lstatSync(link)
        if (st.isSymbolicLink() && readlinkSync(link) === target) continue
        rmSync(link, { recursive: true, force: true })
      } catch {
        // absent
      }
      symlinkSync(target, link)
    }
  }
  for (const name of readdirSync(museDir)) {
    if (!isSharedMuseEntry(name) || wanted.has(name)) continue
    try {
      if (lstatSync(join(museDir, name)).isSymbolicLink()) unlinkSync(join(museDir, name))
    } catch {
      // gone already
    }
  }
}

/** The dir's auth.json back into the vault when the CLI changed it. */
export function recaptureMuseDir(account: string | null): boolean {
  if (!account || !deps?.saveBlob) return false
  const path = join(museAccountDir(deps.root, account), 'muse', 'auth.json')
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return false
  }
  const stored = deps.readBlob(account)
  if (!stored || text.trim() === stored.trim()) return false
  let parsed: { providers?: { meta?: { access_token?: unknown; api_key?: unknown } } }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    return false
  }
  // A logout (no credential left) is not a rotation worth keeping.
  if (!parsed.providers?.meta?.access_token && !parsed.providers?.meta?.api_key) return false
  deps.saveBlob(account, text)
  deps.log?.(`[muse] account ${account}: auth.json changed on disk; saved back to the vault`)
  return true
}

/** Every account dir under the root (for a boot-time recapture). */
export function museAccountDirs(): string[] {
  if (!deps || !existsSync(deps.root)) return []
  return readdirSync(deps.root)
}
