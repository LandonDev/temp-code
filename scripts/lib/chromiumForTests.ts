/** Chrome for Testing discovery and scratch-process ownership. Never use the person's Chrome. */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createProcScan, type ProcessRow } from './procScan'

export const CHROMIUM_MISSING =
  'skipped: Chrome for Testing is not installed (bunx playwright install chromium)'
export const TEST_CHROMIUM_BUNDLE = 'com.google.chrome.for.testing'
export const SCRATCH_CHROME_FRAME = { x: 80, y: 80, w: 1000, h: 800 } as const

export function chromiumForTests(opts: { override?: string; cache?: string } = {}): string | null {
  const override = opts.override ?? process.env.TEMP_CODE_TEST_CHROMIUM
  const usable = (app: string): boolean =>
    existsSync(join(app, 'Contents/MacOS/Google Chrome for Testing'))
  // An explicit path never falls through to an unrelated installed browser.
  if (override) return usable(override) ? override : null
  const cache = opts.cache ?? join(homedir(), 'Library/Caches/ms-playwright')
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(dir, entry.name)
      if (entry.name === 'Google Chrome for Testing.app') {
        if (usable(path)) found.push(path)
      } else walk(path, depth + 1)
    }
  }
  if (existsSync(cache)) walk(cache, 0)
  return found.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1) ?? null
}

/** ps flattens arguments: only whitespace-free scratch profiles can be matched without ambiguity. */
export function hasChromeProfile(command: string, profile: string): boolean {
  if (!profile || /\s/.test(profile)) return false
  const argument = `--user-data-dir=${profile}`
  let at = command.indexOf(argument)
  while (at >= 0) {
    const end = at + argument.length
    if (
      (at === 0 || /\s/.test(command[at - 1])) &&
      (end === command.length || /\s/.test(command[end]))
    )
      return true
    at = command.indexOf(argument, at + 1)
  }
  return false
}

/** The recorded browser and its descendants must each still name the exact scratch profile. */
export function scratchChromiumPids(
  rows: readonly ProcessRow[],
  browserPid: number,
  profile: string,
  ppidOf: (pid: number) => number | null
): number[] {
  if (browserPid <= 1) return []
  const owned = (row: ProcessRow): boolean => {
    if (!hasChromeProfile(row.command, profile)) return false
    const seen = new Set<number>()
    for (let pid: number | null = row.pid; pid && !seen.has(pid); pid = ppidOf(pid)) {
      if (pid === browserPid) return true
      seen.add(pid)
    }
    return false
  }
  return rows
    .filter(owned)
    .map((row) => row.pid)
    .sort((a, b) => Number(a === browserPid) - Number(b === browserPid))
}

/** Recheck the profile before every signal, even after TERM has orphaned a child. */
export function stopScratchChromium(
  browserPid: number,
  profile: string,
  io: {
    processes(): ProcessRow[]
    ppidOf(pid: number): number | null
    signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void
    wait(ms: number): void
  } = {
    ...createProcScan(),
    signal: (pid, signal) => {
      process.kill(pid, signal)
    },
    wait: (ms) => {
      execFileSync('sleep', [String(ms / 1000)])
    }
  }
): number[] {
  const candidates = scratchChromiumPids(io.processes(), browserPid, profile, (pid) =>
    io.ppidOf(pid)
  )
  const ownedNow = (pid: number) =>
    io.processes().some((row) => row.pid === pid && hasChromeProfile(row.command, profile))
  const stopped = new Set<number>()
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    for (const pid of candidates) {
      if (!ownedNow(pid)) continue
      try {
        io.signal(pid, signal)
        stopped.add(pid)
      } catch {
        /* gone */
      }
    }
    if (signal === 'SIGTERM' && candidates.length) io.wait(500)
  }
  for (let tries = 0; candidates.some(ownedNow) && tries < 10; tries++) io.wait(100)
  if (candidates.some(ownedNow))
    throw new Error('scratch Chrome processes did not exit; profile kept')
  return [...stopped]
}
