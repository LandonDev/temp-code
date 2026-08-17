import { watch as fsWatch, statSync } from 'fs'
import { watch as chokidarWatch } from 'chokidar'
import { basename, join, relative, sep } from 'path'

/**
 * One watcher per tree, one fd per tree. chokidar 4+ has no FSEvents
 * backend, so on macOS it opens a kqueue fd per FILE — two ~10k-file
 * worktrees exhausted the process fd table (spawn EBADF), and past that
 * limit the kqueue-held vnodes starved the SYSTEM tables (network down,
 * apps unlaunchable, reboot required — 2026-08-17). Node's own
 * fs.watch(root, {recursive}) rides FSEvents / ReadDirectoryChangesW on
 * darwin/win32; chokidar remains only as the linux fallback.
 */

/** Directory names ignored at any depth (build storms, VCS, app dirs). */
export const WATCH_IGNORED = new Set([
  '.git',
  '.temp-code',
  'node_modules',
  'target',
  'build',
  'dist',
  'out',
  '.gradle',
  '.idea',
  '.next'
])

export function treeIgnored(root: string, abs: string): boolean {
  const rel = relative(root, abs)
  if (!rel || rel.startsWith('..')) return false
  return rel.split(sep).some((seg) => WATCH_IGNORED.has(seg))
}

export type TreeEventKind = 'created' | 'changed' | 'deleted'

export interface TreeWatcher {
  close(): void | Promise<void>
}

export function watchTree(
  root: string,
  opts: {
    onEvent: (kind: TreeEventKind, abs: string) => void
    /** report directory creations too (deletions are always reported —
     *  a gone path has no stat to tell file from dir) */
    dirs?: boolean
  }
): TreeWatcher {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    const w = fsWatch(root, { recursive: true }, (event, filename) => {
      if (!filename) return
      const abs = join(root, filename.toString())
      if (treeIgnored(root, abs)) return
      // 'rename' covers create, delete and both ends of a move; 'change'
      // is a content write. Existence disambiguates; a stat race on a
      // vanishing file lands on 'deleted', which is the truth anyway.
      let isDir: boolean | null = null
      try {
        isDir = statSync(abs).isDirectory()
      } catch {
        // FSEvents echoes events about the root itself as the root's
        // basename — which stats as a missing child. Never a real delete.
        if (filename.toString() === basename(root)) return
        opts.onEvent('deleted', abs)
        return
      }
      if (isDir && !opts.dirs) return
      opts.onEvent(event === 'change' ? 'changed' : 'created', abs)
    })
    w.on('error', () => {}) // transient fs races — the next event self-heals
    return w
  }
  const w = chokidarWatch(root, {
    ignored: (p) => treeIgnored(root, p),
    ignoreInitial: true,
    persistent: true
  })
  w.on('add', (p) => opts.onEvent('created', p))
  w.on('change', (p) => opts.onEvent('changed', p))
  w.on('unlink', (p) => opts.onEvent('deleted', p))
  if (opts.dirs) {
    w.on('addDir', (p) => opts.onEvent('created', p))
    w.on('unlinkDir', (p) => opts.onEvent('deleted', p))
  }
  w.on('error', () => {})
  return w
}
