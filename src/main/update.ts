import { app, ipcMain, BrowserWindow } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import release from '../../release.json'

const exec = promisify(execFile)

/**
 * Self-update, local-first: releases are tags in the source repo
 * (`release-N` + release.json on master, written by scripts/release.ts).
 * Checking reads master's release.json. Applying prefers the fast path —
 * when dependencies didn't change between the running release and the
 * target, only the built JS is synced into the installed bundle in
 * place, re-sealed, and the app relaunches itself (~seconds). A
 * dependency or electron change falls back to the full electron-builder
 * repack with a swap script.
 */

const REPO = process.env.TEMP_CODE_REPO ?? join(homedir(), 'IdeaProjects', 'temp-code')
const PROD_WORKTREE = `${REPO}-prod`
const APP_DEST = '/Applications/TempCode.app'
const APP_PAYLOAD = join(APP_DEST, 'Contents', 'Resources', 'app')
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
  /** while building: which step, its latest output line, and timing for
   *  a real progress bar (ETA learned from previous runs) */
  step?: string
  detail?: string
  stepStartedAt?: number
  stepEtaMs?: number
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

// ── step timing: ETAs come from how long each step took last time ──────

const timesPath = (): string => join(app.getPath('userData'), 'update-times.json')

function loadTimes(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(timesPath(), 'utf8')) as Record<string, number>
  } catch {
    return {}
  }
}

function recordTime(name: string, ms: number): void {
  const t = loadTimes()
  // EMA keeps the estimate honest as the machine and repo change.
  t[name] = t[name] ? Math.round(t[name] * 0.5 + ms * 0.5) : ms
  try {
    writeFileSync(timesPath(), JSON.stringify(t))
  } catch {
    /* estimates only */
  }
}

/** Run one update step, streaming its last output line into the status
 *  so the button never looks stuck. */
function step(
  name: string,
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<void> {
  const startedAt = Date.now()
  setStatus({
    step: name,
    detail: undefined,
    stepStartedAt: startedAt,
    stepEtaMs: loadTimes()[name]
  })
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    let lastLine = ''
    let tail = ''
    const onChunk = (chunk: Buffer): void => {
      tail = (tail + chunk.toString()).slice(-4096)
      const lines = tail
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      const line = lines.at(-1) ?? ''
      if (line && line !== lastLine) {
        lastLine = line
        setStatus({ detail: line.slice(0, 120) })
      }
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        recordTime(name, Date.now() - startedAt)
        resolve()
      } else reject(new Error(`${name} failed (${code})${lastLine ? `: ${lastLine}` : ''}`))
    })
  })
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

/** Dependencies unchanged between the running release and the target →
 *  only built JS needs to move; the bundle's node_modules and the
 *  Electron framework are already right. */
async function depsUnchanged(target: number): Promise<boolean> {
  try {
    await exec('git', [
      '-C',
      REPO,
      'diff',
      '--quiet',
      `release-${status.current}`,
      `release-${target}`,
      '--',
      'package.json',
      'bun.lock',
      'electron-builder.yml'
    ])
    return true
  } catch {
    return false
  }
}

/** The Developer ID identity from the login keychain, or ad-hoc. */
async function signingIdentity(): Promise<string> {
  try {
    const { stdout } = await exec('security', ['find-identity', '-v', '-p', 'codesigning'])
    const m = stdout.match(/([0-9A-F]{40}) "Developer ID Application/)
    return m ? m[1] : '-'
  } catch {
    return '-'
  }
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
      await step('Preparing', 'git', [
        '-C',
        REPO,
        'worktree',
        'add',
        '--detach',
        PROD_WORKTREE,
        tag
      ])
    } else {
      await step('Preparing', 'git', ['-C', PROD_WORKTREE, 'checkout', '--force', '--detach', tag])
    }
    const env = { ...process.env, PATH: `${join(homedir(), '.bun', 'bin')}:${process.env.PATH}` }
    const fast = (await depsUnchanged(target)) && existsSync(APP_PAYLOAD)

    await step('Installing dependencies', bunBin(), ['install'], { cwd: PROD_WORKTREE, env })
    await step('Building', bunBin(), ['x', 'electron-vite', 'build'], { cwd: PROD_WORKTREE, env })

    if (fast) {
      // In-place: sync the fresh JS payload into the installed bundle,
      // re-seal the signature, and let Electron relaunch us.
      for (const dir of ['out', 'resources']) {
        await step('Applying', 'rsync', [
          '-a',
          '--delete',
          join(PROD_WORKTREE, dir) + '/',
          join(APP_PAYLOAD, dir) + '/'
        ])
      }
      await step('Applying', 'cp', [
        join(PROD_WORKTREE, 'package.json'),
        join(PROD_WORKTREE, 'release.json'),
        APP_PAYLOAD
      ])
      await step('Sealing', 'codesign', ['--force', '-s', await signingIdentity(), APP_DEST])
      setStatus({ phase: 'restarting', step: undefined, detail: undefined })
      app.relaunch()
      setTimeout(() => app.exit(0), 300)
      return
    }

    // Full path: dependencies or electron moved — real repack + swap.
    await step('Packaging', bunBin(), ['x', 'electron-builder', '--dir'], {
      cwd: PROD_WORKTREE,
      env
    })
    const dist = join(PROD_WORKTREE, 'dist')
    const macDir = (await readdir(dist)).find((d) => d.startsWith('mac'))
    const built = macDir ? join(dist, macDir, 'TempCode.app') : null
    if (!built || !existsSync(built)) throw new Error('build produced no TempCode.app')

    // The swap has to outlive this process: a detached script waits for
    // us to exit, replaces the installed app, and reopens it.
    setStatus({ phase: 'restarting', step: undefined, detail: undefined })
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
    setStatus({
      phase: 'error',
      step: undefined,
      detail: undefined,
      error: err instanceof Error ? err.message : String(err)
    })
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
