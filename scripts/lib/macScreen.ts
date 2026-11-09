/** Screen admission for unattended proofs; never wakes or unlocks the Mac. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface MacScreen { locked: boolean; asleep: boolean }
export const SCREEN_SKIP_NOTE = 'the Mac is locked or asleep; run it by hand when unlocked'
export const SCREEN_SKIP_LINE = 'skipped: the Mac is locked or asleep'

// Same rule as computer-proof-probe.swift's screen command, without AppKit or its other probes.
export const SCREEN_SOURCE = String.raw`import CoreGraphics
let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
let locked = session["CGSSessionScreenIsLocked"] as? Bool ?? false
let onConsole = session["kCGSSessionOnConsoleKey"] as? Bool ?? true
let asleep = CGDisplayIsAsleep(CGMainDisplayID()) != 0
print("{\"locked\":\(locked || !onConsole),\"asleep\":\(asleep)}")
`

/** Parse the probe's recorded screen replies; missing fields are an unreadable screen. */
export function parseMacScreen(text: string): MacScreen | null {
  try {
    const value = JSON.parse(text)
    if (typeof value?.locked !== 'boolean' || typeof value?.asleep !== 'boolean') return null
    return { locked: value.locked, asleep: value.asleep }
  } catch {
    return null
  }
}

/** Compile once per source in the gate logs; compile and read share a 1.95 s budget. */
export function readMacScreen(logDir: string): MacScreen | null {
  const deadline = Date.now() + 1950
  const binary = join(logDir, `screen-${createHash('sha256').update(SCREEN_SOURCE).digest('hex').slice(0, 12)}`)
  const source = `${binary}.${process.pid}.swift`
  const built = `${binary}.${process.pid}`
  try {
    mkdirSync(logDir, { recursive: true })
    if (!existsSync(binary)) {
      writeFileSync(source, SCREEN_SOURCE)
      execFileSync('/usr/bin/xcrun', ['swiftc', source, '-o', built], { timeout: 1800, stdio: 'pipe' })
      renameSync(built, binary)
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return null
    return parseMacScreen(execFileSync(binary, [], { encoding: 'utf8', timeout: Math.min(400, remaining), stdio: 'pipe' }))
  } catch {
    return null
  } finally {
    rmSync(source, { force: true })
    rmSync(built, { force: true })
  }
}

/** Direct --gate runs check before any build, wait, scratch app, or model starts. */
export function gateScreenSkip(
  gate: boolean,
  root: string,
  platform: NodeJS.Platform = process.platform,
  read: () => MacScreen | null = () => {
    const gitDir = execFileSync('git', ['-C', root, 'rev-parse', '--git-dir'], { encoding: 'utf8', timeout: 400 }).trim()
    return readMacScreen(join(resolve(root, gitDir), 'temp-code-gate', 'logs'))
  }
): string | null {
  if (!gate || platform !== 'darwin') return null
  try {
    const screen = read()
    return screen && !screen.locked && !screen.asleep ? null : SCREEN_SKIP_LINE
  } catch {
    return SCREEN_SKIP_LINE
  }
}
