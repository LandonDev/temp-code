import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The computer preview proofs' scratch app: "TC Probe" (scripts/mac/computer-probe-app.swift) built
 * into `dir`, signed ad hoc, launched in the background with `--tick` so its window keeps changing and
 * a capture stream keeps sending. It never activates itself and its window takes no click; quitting it
 * leaves nothing behind but what `cleanupProbeApp` removes.
 */
export const PROBE_APP_NAME = 'TC Probe'
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

export interface ProbeAppBuild {
  app: string
  binary: string
  bundleId: string
}

export function buildProbeApp(root: string, dir: string, bundleId: string): ProbeAppBuild {
  const app = join(dir, `${PROBE_APP_NAME}.app`)
  const binary = join(app, 'Contents/MacOS', PROBE_APP_NAME)
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true })
  execFileSync('xcrun', ['swiftc', '-O', '-o', binary, join(root, 'scripts/mac/computer-probe-app.swift')], { stdio: 'pipe' })
  writeFileSync(
    join(app, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${bundleId}</string>
  <key>CFBundleName</key><string>${PROBE_APP_NAME}</string>
  <key>CFBundleExecutable</key><string>${PROBE_APP_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`
  )
  execFileSync('codesign', ['-s', '-', '--force', app], { stdio: 'pipe' })
  return { app, binary, bundleId }
}

/**
 * Every way a process's command line may spell this binary: as given, its real path, and with or
 * without /private before /tmp, /var or /etc (Launch Services starts an app under /tmp as
 * /private/tmp/...).
 */
export function binarySpellings(binary: string): string[] {
  const all = [binary]
  try {
    all.push(realpathSync(binary))
  } catch {
    // not on disk
  }
  for (const p of [...all]) {
    if (/^\/(tmp|var|etc)\//.test(p)) all.push(`/private${p}`)
    else if (/^\/private\/(tmp|var|etc)\//.test(p)) all.push(p.slice('/private'.length))
  }
  return [...new Set(all)]
}

/** The pid of the newest process running this binary, under any of its spellings, or 0. */
function pidOf(binary: string): number {
  for (const spelling of binarySpellings(binary)) {
    try {
      const out = execFileSync('pgrep', ['-nf', `^${spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`], { encoding: 'utf8' }).trim()
      if (Number(out)) return Number(out)
    } catch {
      // no match
    }
  }
  return 0
}

/**
 * `open -g -n <app> --args --tick`: Launch Services' background launch, as `apps.launch` does, with the
 * tick on. Answers the pid and whether the app came to the front anyway (`bounced`; the caller's
 * `frontmost` reads the Mac, and the person's app is put back).
 */
export async function launchTickingProbe(
  build: ProbeAppBuild,
  frontmost: () => { pid: number; bundleId: string | null }
): Promise<{ pid: number; bounced: string | null }> {
  const before = frontmost()
  execFileSync('open', ['-g', '-n', build.app, '--args', '--tick'], { stdio: 'pipe' })
  let pid = 0
  for (const until = Date.now() + 10_000; !pid && Date.now() < until; ) {
    pid = pidOf(build.binary)
    if (!pid) await new Promise((r) => setTimeout(r, 100))
  }
  if (!pid) throw new Error('TC Probe did not start within 10 s')
  await new Promise((r) => setTimeout(r, 1_000))
  let bounced: string | null = null
  if (frontmost().pid === pid) {
    bounced = 'TC Probe came to the front at launch'
    if (before.bundleId) execFileSync('osascript', ['-e', `tell application id "${before.bundleId}" to activate`])
    await new Promise((r) => setTimeout(r, 500))
    bounced += frontmost().pid === pid ? "; the person's app could not be put back" : `; ${before.bundleId} put back in front`
  }
  return { pid, bounced }
}

/**
 * Ends the pid (SIGTERM, then SIGKILL), unregisters the bundle and drops any saved state. With no pid
 * (a launch the run did not see through) it ends whatever runs the build's binary.
 */
export function cleanupProbeApp(build: ProbeAppBuild | null, pid: number): string[] {
  const done: string[] = []
  if (!pid && build) pid = pidOf(build.binary)
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM')
      done.push(`ended TC Probe ${pid}`)
    } catch {
      done.push('TC Probe was gone')
    }
    try {
      execFileSync('sleep', ['0.5'])
      process.kill(pid, 'SIGKILL')
    } catch {
      // gone
    }
  }
  if (build) {
    try {
      execFileSync(LSREGISTER, ['-u', build.app], { stdio: 'ignore' })
      done.push('unregistered TC Probe from Launch Services')
    } catch {
      // nothing registered
    }
    rmSync(join(homedir(), 'Library/Saved Application State', `${build.bundleId}.savedState`), { recursive: true, force: true })
  }
  return done
}

/** The Mac locked or its display went dark during a proof: the run stops, inconclusive. */
export class ScreenLost extends Error {}

/**
 * The proofs' one gate while the person is away: the screen must stay unlocked and awake. `start` reads
 * it once (scripts/mac/computer-proof-probe.swift `screen`) and then every second; `lost` rejects at the
 * first locked or dark read, `check()` reads it again and throws, and `nap(ms)` is a sleep that throws,
 * so a run unwinds at its next pause and the proof's cleanup follows.
 */
export class ScreenWatch {
  private why: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private reject: (e: ScreenLost) => void = () => undefined
  readonly lost = new Promise<never>((_, reject) => (this.reject = reject))
  private probe = ''

  constructor() {
    this.lost.catch(() => undefined)
  }

  start(probe: string, everyMs = 1_000): void {
    this.probe = probe
    this.check()
    let reading = false
    this.timer = setInterval(() => {
      if (reading) return
      reading = true
      execFile(probe, ['screen'], { encoding: 'utf8', timeout: 10_000 }, (error, out) => {
        reading = false
        try {
          if (!error) this.judge(out)
        } catch {
          // a garbled read; the next one decides
        }
      })
    }, everyMs)
  }

  check(): void {
    if (!this.why && this.probe) this.judge(execFileSync(this.probe, ['screen'], { encoding: 'utf8', timeout: 10_000 }))
    if (this.why) throw new ScreenLost(this.why)
  }

  async nap(ms: number): Promise<void> {
    if (this.why) throw new ScreenLost(this.why)
    await new Promise((r) => setTimeout(r, ms))
    if (this.why) throw new ScreenLost(this.why)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private judge(out: string): void {
    const s = JSON.parse(out) as { locked: boolean; asleep: boolean }
    if (this.why || (!s.locked && !s.asleep)) return
    this.why = `stopped: ${s.locked ? 'the Mac locked' : "the Mac's display went dark"} at ${new Date().toISOString()}`
    this.stop()
    this.reject(new ScreenLost(this.why))
  }
}

/**
 * A helper the proofs compile once (never the shell's probe tool), one JSON line per call:
 *   taps <pid>     how many event taps that process holds and how many are enabled (CGGetEventTapList)
 *   windows <pid>  that process's on-screen windows: layer, bounds (global points) and alpha
 */
export const MAC_EXTRA_SOURCE = `import CoreGraphics
import Foundation
let args = Array(CommandLine.arguments.dropFirst())
let pid = Int32(args.dropFirst().first ?? "0") ?? 0
switch args.first {
case "taps":
    var count: UInt32 = 0
    CGGetEventTapList(0, nil, &count)
    var taps = [CGEventTapInformation](repeating: CGEventTapInformation(), count: Int(count))
    CGGetEventTapList(count, &taps, &count)
    let mine = taps.prefix(Int(count)).filter { $0.tappingProcess == pid }
    print("{\\"taps\\":\\(mine.count),\\"enabled\\":\\(mine.filter { $0.enabled }.count)}")
case "windows":
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    let mine: [[String: Any]] = list.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }.map {
        let b = $0[kCGWindowBounds as String] as? [String: Double] ?? [:]
        return ["layer": $0[kCGWindowLayer as String] as? Int ?? 0, "x": b["X"] ?? 0, "y": b["Y"] ?? 0, "w": b["Width"] ?? 0, "h": b["Height"] ?? 0, "alpha": $0[kCGWindowAlpha as String] as? Double ?? 1]
    }
    let data = try! JSONSerialization.data(withJSONObject: ["windows": mine], options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
default:
    FileHandle.standardError.write(Data("usage: taps <pid> | windows <pid>\\n".utf8))
    exit(2)
}
`
