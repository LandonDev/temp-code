import { app, ipcMain, BrowserWindow } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import release from '../../release.json'

const exec = promisify(execFile)

/**
 * Self-update, local-first: releases are tags in the source repo
 * (`release-N` + release.json on master, written by scripts/release.ts).
 * Checking reads master's release.json; applying builds that tag in a
 * dedicated prod worktree, swaps /Applications/TempCode.app, and
 * relaunches. Dev instances report their release but never apply.
 */

const REPO = process.env.TEMP_CODE_REPO ?? join(homedir(), 'IdeaProjects', 'temp-code')
const PROD_WORKTREE = `${REPO}-prod`
const APP_DEST = '/Applications/TempCode.app'
const CHECK_EVERY_MS = 30 * 60 * 1000

export interface UpdateStatus {
  /** the release this build is running */
  current: number
  /** newest release on master, once checked */
  latest: number | null
  notes: string
  /** dev-mode instances show state but can't apply */
  canApply: boolean
  phase: 'idle' | 'checking' | 'building' | 'restarting' | 'error'
  error?: string
}

let status: UpdateStatus = {
  current: release.n,
  latest: null,
  notes: '',
  canApply: app.isPackaged,
  phase: 'idle'
}

function setStatus(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch }
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('update-status', status)
  }
}

/** bun lives in ~/.bun for this user; packaged apps get a bare PATH. */
function bunBin(): string {
  const local = join(homedir(), '.bun', 'bin', 'bun')
  return existsSync(local) ? local : 'bun'
}

async function check(): Promise<UpdateStatus> {
  if (status.phase === 'building' || status.phase === 'restarting') return status
  setStatus({ phase: 'checking' })
  try {
    const { stdout } = await exec('git', ['-C', REPO, 'show', 'master:release.json'])
    const latest = JSON.parse(stdout) as { n: number; notes: string }
    setStatus({ phase: 'idle', latest: latest.n, notes: latest.notes, error: undefined })
  } catch (err) {
    setStatus({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
  }
  return status
}

async function apply(): Promise<void> {
  if (!app.isPackaged || status.phase === 'building' || status.phase === 'restarting') return
  const target = status.latest
  if (!target || target <= status.current) return
  setStatus({ phase: 'building', error: undefined })
  try {
    const tag = `release-${target}`
    // The prod worktree shares the repo's object store, so the tag is
    // visible without any fetch. Created lazily on the first update.
    if (!existsSync(PROD_WORKTREE)) {
      await exec('git', ['-C', REPO, 'worktree', 'add', '--detach', PROD_WORKTREE, tag])
    } else {
      await exec('git', ['-C', PROD_WORKTREE, 'checkout', '--force', '--detach', tag])
    }
    const env = { ...process.env, PATH: `${join(homedir(), '.bun', 'bin')}:${process.env.PATH}` }
    await exec(bunBin(), ['install'], { cwd: PROD_WORKTREE, env, maxBuffer: 64 * 1024 * 1024 })
    await exec(bunBin(), ['run', 'build:app'], {
      cwd: PROD_WORKTREE,
      env,
      maxBuffer: 64 * 1024 * 1024
    })

    // electron-builder --dir puts the bundle under dist/mac*/TempCode.app.
    const dist = join(PROD_WORKTREE, 'dist')
    const macDir = (await readdir(dist)).find((d) => d.startsWith('mac'))
    const built = macDir ? join(dist, macDir, 'TempCode.app') : null
    if (!built || !existsSync(built)) throw new Error('build produced no TempCode.app')

    // The swap has to outlive this process: a detached script waits for
    // us to exit, replaces the installed app, and reopens it.
    setStatus({ phase: 'restarting' })
    const script = join(mkdtempSync(join(tmpdir(), 'tempcode-update-')), 'swap.sh')
    writeFileSync(
      script,
      `#!/bin/bash
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done
rm -rf "${APP_DEST}"
ditto "${built}" "${APP_DEST}"
open "${APP_DEST}"
`,
      { mode: 0o755 }
    )
    spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }).unref()
    setTimeout(() => app.quit(), 400)
  } catch (err) {
    setStatus({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
  }
}

export function registerUpdates(): void {
  ipcMain.handle('update-get', () => status)
  ipcMain.handle('update-check', () => check())
  ipcMain.handle('update-apply', () => {
    void apply()
    return status
  })
  // Looks on its own: shortly after boot, then on an interval.
  setTimeout(() => void check(), 5_000)
  setInterval(() => void check(), CHECK_EVERY_MS)
}
