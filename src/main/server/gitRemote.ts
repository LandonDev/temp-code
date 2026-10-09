import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * Reads a checkout's origin remote straight from its git config: no process
 * spawn, so it never touches the child budget. A worktree's `.git` is a file
 * naming its gitdir; the shared config lives behind that gitdir's
 * `commondir`.
 */

/** Path of the config file that holds `dir`'s remotes, or null when `dir` is not a checkout. */
async function gitConfigPath(dir: string): Promise<string | null> {
  const dotGit = join(dir, '.git')
  let info
  try {
    info = await stat(dotGit)
  } catch {
    return null
  }
  if (info.isDirectory()) return join(dotGit, 'config')
  let pointer: string
  try {
    pointer = await readFile(dotGit, 'utf8')
  } catch {
    return null
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(pointer)
  if (!m) return null
  const gitdir = isAbsolute(m[1]) ? m[1] : resolve(dir, m[1])
  try {
    const common = (await readFile(join(gitdir, 'commondir'), 'utf8')).trim()
    if (common) return join(resolve(gitdir, common), 'config')
  } catch {
    // a main checkout's gitdir has no commondir
  }
  return join(gitdir, 'config')
}

/** The first `url` under `[remote "origin"]` in a git config, or null. */
export function parseOriginUrl(config: string): string | null {
  let inOrigin = false
  for (const raw of config.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/i.test(line)
      continue
    }
    if (!inOrigin) continue
    const m = /^url\s*=\s*(.+?)\s*$/.exec(line)
    if (m) return m[1]
  }
  return null
}

export async function originRemoteUrl(dir: string): Promise<string | null> {
  const path = await gitConfigPath(dir)
  if (!path) return null
  try {
    return parseOriginUrl(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

const SLUG_PART = /^[A-Za-z0-9_.-]+$/

/** `owner/name` for a github.com remote url; null for any other host. */
export function githubRepoFromRemote(url: string): string | null {
  const m =
    /^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim())
  if (!m) return null
  const [, owner, name] = m
  if (!SLUG_PART.test(owner) || !SLUG_PART.test(name)) return null
  return `${owner}/${name}`
}

/** Modified time (ms) of the config file `originRemoteUrl` reads, or null. */
export async function gitConfigMtime(dir: string): Promise<number | null> {
  const path = await gitConfigPath(dir)
  if (!path) return null
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}
