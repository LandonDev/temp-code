import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileBudgeted as execFileP } from './spawnBudget'
import type { WorkspaceIcon } from '@shared/domain'


type GitHost = WorkspaceIcon['host']

/** Icon files worth showing, best first — big app icons before 16px .ico. */
const CANDIDATES = [
  'apple-touch-icon.png',
  'public/apple-touch-icon.png',
  'resources/icon.png',
  'build/icon.png',
  'public/logo.svg',
  'public/logo.png',
  'logo.svg',
  'logo.png',
  'public/favicon.svg',
  'favicon.svg',
  'public/favicon.png',
  'favicon.png',
  'app/favicon.ico',
  'src/app/favicon.ico',
  'public/favicon.ico',
  'static/favicon.ico',
  'favicon.ico'
]

const MIME: Record<string, string> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  ico: 'image/x-icon'
}

const cache = new Map<string, Promise<WorkspaceIcon>>()

export function workspaceIcon(dir: string): Promise<WorkspaceIcon> {
  let hit = cache.get(dir)
  if (!hit) {
    hit = resolve(dir).catch(() => ({ dataUrl: null, host: null }))
    cache.set(dir, hit)
  }
  return hit
}

async function resolve(dir: string): Promise<WorkspaceIcon> {
  const { host, owner } = await originHost(dir)
  const local = await localIcon(dir)
  if (local) return { dataUrl: local, host }
  if (host === 'github' && owner) {
    const avatar = await fetchAvatar(`https://github.com/${owner}.png?size=128`)
    if (avatar) return { dataUrl: avatar, host }
  }
  return { dataUrl: null, host }
}

async function localIcon(dir: string): Promise<string | null> {
  for (const rel of CANDIDATES) {
    const path = join(dir, rel)
    try {
      const s = await stat(path)
      if (!s.isFile() || s.size === 0 || s.size > 1024 * 1024) continue
      const ext = rel.split('.').pop() as string
      const buf = await readFile(path)
      return `data:${MIME[ext]};base64,${buf.toString('base64')}`
    } catch {
      // not there — next candidate
    }
  }
  return null
}

async function originHost(dir: string): Promise<{ host: GitHost | null; owner: string | null }> {
  try {
    const { stdout } = await execFileP('git', ['-C', dir, 'remote', 'get-url', 'origin'])
    const url = stdout.trim()
    const host = url.includes('github.com')
      ? 'github'
      : url.includes('gitlab')
        ? 'gitlab'
        : url.includes('bitbucket')
          ? 'bitbucket'
          : null
    // git@github.com:owner/repo.git | https://github.com/owner/repo.git
    const owner = /github\.com[:/]([^/]+)\//.exec(url)?.[1] ?? null
    return { host, owner }
  } catch {
    return { host: null, owner: null }
  }
}

async function fetchAvatar(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'follow' })
    if (!res.ok) return null
    const type = res.headers.get('content-type') ?? 'image/png'
    if (!type.startsWith('image/')) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0 || buf.length > 1024 * 1024) return null
    return `data:${type};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}
