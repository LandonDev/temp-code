import type { Phone, PhoneConnection, Simulator, SimulatorState, XcodeInfo } from '@shared/contract-hostdevices'

/**
 * Parsers for what the Mac's tools print (docs/box.md "Devices on the
 * Mac"). Pure: every one takes text and answers rows, so the fixtures under
 * ./fixtures (captured on the user's Mac with Xcode 27 beta) pin them.
 */

/** A simulator before its holder is joined (hostDevices.ts attachHolders). */
export type SimulatorRow = Omit<Simulator, 'holder' | 'cpu'>
/** A phone before its holder is joined. */
export type PhoneRow = Omit<Phone, 'holder'>

// ── xcrun simctl list -j devices ──────────────────────────────────────

/** "com.apple.CoreSimulator.SimRuntime.iOS-26-0" → "iOS 26.0"; an unknown shape answers itself. */
export function runtimeLabel(identifier: string): string {
  const tail = identifier.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '')
  const m = /^([A-Za-z]+)-(\d+(?:-\d+)*)$/.exec(tail)
  if (!m) return tail
  return `${m[1]} ${m[2]!.replace(/-/g, '.')}`
}

const simulatorState = (raw: unknown): { state: SimulatorState; stateText?: string } => {
  const text = typeof raw === 'string' ? raw : ''
  const low = text.toLowerCase()
  if (low === 'booted') return { state: 'booted' }
  if (low === 'shutdown') return { state: 'shutdown' }
  return { state: 'other', stateText: text || 'unknown' }
}

/**
 * The devices simctl lists, every runtime flattened, unavailable ones (a
 * runtime no longer installed) left out. Booted first, then by runtime and
 * name, so the pane reads top down.
 */
export function parseSimctlDevices(json: string): SimulatorRow[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('simctl printed no JSON')
  }
  const devices = (parsed as { devices?: unknown })?.devices
  if (!devices || typeof devices !== 'object') throw new Error('simctl printed no devices')
  const rows: SimulatorRow[] = []
  for (const [runtimeId, list] of Object.entries(devices as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue
    const runtime = runtimeLabel(runtimeId)
    for (const d of list as Record<string, unknown>[]) {
      if (!d || typeof d.udid !== 'string') continue
      if (d.isAvailable === false) continue
      rows.push({
        udid: d.udid,
        name: typeof d.name === 'string' ? d.name : d.udid,
        runtime,
        ...simulatorState(d.state)
      })
    }
  }
  const rank = (s: SimulatorState): number => (s === 'booted' ? 0 : s === 'other' ? 1 : 2)
  return rows.sort(
    (a, b) =>
      rank(a.state) - rank(b.state) ||
      compareRuntimes(b.runtime, a.runtime) ||
      a.name.localeCompare(b.name)
  )
}

/** Newest runtime first: "iOS 26.0" before "iOS 18.5"; platforms by name. */
function compareRuntimes(a: string, b: string): number {
  const [pa, va = ''] = a.split(' ')
  const [pb, vb = ''] = b.split(' ')
  if (pa !== pb) return (pa ?? '').localeCompare(pb ?? '')
  return compareVersions(va, vb)
}

/** 1 when a is newer than b, numeric by segment ("26.0" > "18.5", "27.1" > "27.0.1"? no: 27.1 > 27.0). */
export function compareVersions(a: string, b: string): number {
  const as = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const bs = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const d = (as[i] ?? 0) - (bs[i] ?? 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

// ── xcrun devicectl list devices --json-output ────────────────────────

/** connected: a tunnel is up; paired: known and reachable but not attached right now (tunnel disconnected); unavailable: devicectl cannot reach it. */
const phoneConnection = (props: Record<string, unknown> | undefined): PhoneConnection => {
  const tunnel = typeof props?.tunnelState === 'string' ? props.tunnelState.toLowerCase() : ''
  if (tunnel === 'connected') return 'connected'
  if (tunnel === 'unavailable') return 'unavailable'
  const pairing = typeof props?.pairingState === 'string' ? props.pairingState.toLowerCase() : ''
  if (pairing === 'paired') return 'paired'
  return 'unavailable'
}

/** devicectl pairs Apple TVs and watches too; the row is for the phones (and iPads) a thread builds to. */
const PHONE_TYPES = new Set(['iphone', 'ipad'])

/** USB or Wi-Fi; any other devicectl word ("samemachine") names nothing a person reads, so it is left out. */
const transportLabel = (props: Record<string, unknown> | undefined): string | undefined => {
  const t = typeof props?.transportType === 'string' ? props.transportType.toLowerCase() : ''
  if (t === 'wired') return 'USB'
  if (t === 'localnetwork') return 'Wi-Fi'
  return undefined
}

/**
 * The iPhones and iPads devicectl knows, with their connection: `connected`
 * when a tunnel is up, `paired` when known but away, `unavailable` when it
 * cannot be reached. Apple TVs and watches are left out. Connected first.
 */
export function parseDevicectlDevices(json: string): PhoneRow[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('devicectl printed no JSON')
  }
  const list = (parsed as { result?: { devices?: unknown } })?.result?.devices
  if (!Array.isArray(list)) throw new Error('devicectl printed no devices')
  const rows: PhoneRow[] = []
  for (const d of list as Record<string, unknown>[]) {
    const hw = d.hardwareProperties as Record<string, unknown> | undefined
    const dev = d.deviceProperties as Record<string, unknown> | undefined
    const conn = d.connectionProperties as Record<string, unknown> | undefined
    const udid =
      typeof hw?.udid === 'string' ? hw.udid : typeof d.identifier === 'string' ? d.identifier : null
    if (!udid) continue
    const deviceType = typeof hw?.deviceType === 'string' ? hw.deviceType.toLowerCase() : 'iphone'
    if (!PHONE_TYPES.has(deviceType)) continue
    const platform = typeof hw?.platform === 'string' ? hw.platform : 'iOS'
    const osVersion = typeof dev?.osVersionNumber === 'string' ? dev.osVersionNumber : ''
    const transport = transportLabel(conn)
    rows.push({
      udid,
      name: typeof dev?.name === 'string' ? dev.name : udid,
      model:
        typeof hw?.marketingName === 'string'
          ? hw.marketingName
          : typeof hw?.productType === 'string'
            ? hw.productType
            : 'iPhone',
      os: osVersion ? `${platform} ${osVersion}` : platform,
      connection: phoneConnection(conn),
      ...(transport ? { transport } : {})
    })
  }
  const rank = (c: PhoneConnection): number => (c === 'connected' ? 0 : c === 'paired' ? 1 : 2)
  return rows.sort((a, b) => rank(a.connection) - rank(b.connection) || a.name.localeCompare(b.name))
}

// ── ps -axo pid,pcpu,command ──────────────────────────────────────────

/**
 * CPU share per booted simulator: the %CPU of every process whose command
 * line names the simulator's device directory (`…/Devices/<UDID>/…`: its
 * launchd_sim and everything it spawned), summed. One `ps` for all of them.
 */
export function parseSimulatorCpu(psOutput: string, udids: readonly string[]): Map<string, number> {
  const totals = new Map<string, number>()
  if (udids.length === 0) return totals
  const wanted = new Map(udids.map((u) => [u.toUpperCase(), u]))
  for (const line of psOutput.split('\n')) {
    const m = /^\s*\d+\s+([\d.]+)\s+(.*)$/.exec(line)
    if (!m) continue
    const cpu = Number.parseFloat(m[1]!)
    if (!Number.isFinite(cpu)) continue
    const command = m[2]!
    for (const found of command.toUpperCase().matchAll(/DEVICES\/([0-9A-F-]{36})/g)) {
      const udid = wanted.get(found[1]!)
      if (!udid) continue
      totals.set(udid, Math.round(((totals.get(udid) ?? 0) + cpu) * 10) / 10)
      break
    }
  }
  return totals
}

// ── the Xcode in use ─────────────────────────────────────────────────

/** CFBundleShortVersionString out of an Xcode's Contents/version.plist. */
export function xcodeVersionFromPlist(plist: string): string | undefined {
  const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
  return m?.[1]?.trim() || undefined
}

/** The Xcode name a developer dir belongs to: "/Applications/Xcode-beta.app/Contents/Developer" → "/Applications/Xcode-beta.app". */
export function xcodeAppOf(developerDir: string): string | null {
  const m = /^(.*\.app)\/Contents\/Developer\/?$/.exec(developerDir.trim())
  return m?.[1] ?? null
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9'
/** filevercmp's order: digits lowest, then letters by code, then everything else (so "Xcode-26" sorts before "Xcode-beta"). */
const order = (c: string | undefined): number => {
  if (c === undefined || isDigit(c)) return 0
  if (/[A-Za-z]/.test(c)) return c.charCodeAt(0)
  if (c === '~') return -1
  return c.charCodeAt(0) + 256
}

/** The Debian version comparison coreutils' `sort -V` runs on two names (filevercmp's verrevcmp). */
function verrevcmp(a: string, b: string): number {
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    let first = 0
    while ((i < a.length && !isDigit(a[i])) || (j < b.length && !isDigit(b[j]))) {
      const d = order(a[i]) - order(b[j])
      if (d) return d
      i++
      j++
    }
    while (a[i] === '0') i++
    while (b[j] === '0') j++
    while (isDigit(a[i]) && isDigit(b[j])) {
      if (!first) first = a.charCodeAt(i) - b.charCodeAt(j)
      i++
      j++
    }
    if (isDigit(a[i])) return 1
    if (isDigit(b[j])) return -1
    if (first) return first
  }
  return 0
}

/** `sort -V` on two file names: the extension-like suffix is set aside first, as coreutils does. */
export function versionSort(a: string, b: string): number {
  const strip = (s: string): string => s.replace(/(\.[A-Za-z~][A-Za-z0-9~]*)*$/, '')
  return verrevcmp(strip(a), strip(b)) || verrevcmp(a, b)
}

/** The last of `ls -d /Applications/Xcode*.app | sort -V`, as scripts/ios-device.sh picks it: "Xcode-26.1.app" after "Xcode-26.app", "Xcode-beta.app" after both. */
export function newestXcode(apps: readonly string[]): string | null {
  const named = apps.filter((a) => /\/Xcode[^/]*\.app$/.test(a))
  if (named.length === 0) return null
  const base = (app: string): string => app.slice(app.lastIndexOf('/') + 1)
  return [...named].sort((a, b) => versionSort(base(a), base(b)))[named.length - 1]!
}

export interface XcodeLookup {
  /** process.env.DEVELOPER_DIR, when set. */
  developerDir?: string
  /** Every /Applications/Xcode*.app on disk. */
  apps: readonly string[]
  /** `xcode-select -p`, when it answered. */
  xcodeSelect?: string
  /** The bundle's Contents/version.plist, when readable. */
  versionPlist: (app: string) => string | null
}

/**
 * The Xcode the tools use, resolved as scripts/ios-device.sh does: the
 * environment's DEVELOPER_DIR first, else the newest Xcode*.app under
 * /Applications, else what xcode-select names.
 */
export function resolveXcode(lookup: XcodeLookup): XcodeInfo | null {
  let path: string | null = null
  let from: XcodeInfo['from'] = 'newest'
  if (lookup.developerDir) {
    path = xcodeAppOf(lookup.developerDir)
    from = 'developerDir'
  }
  if (!path) {
    path = newestXcode(lookup.apps)
    from = 'newest'
  }
  if (!path && lookup.xcodeSelect) {
    path = xcodeAppOf(lookup.xcodeSelect)
    from = 'xcodeSelect'
  }
  if (!path) return null
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.app$/, '')
  const plist = lookup.versionPlist(path)
  const version = plist ? xcodeVersionFromPlist(plist) : undefined
  return { path, name, from, ...(version ? { version } : {}) }
}

// ── load ─────────────────────────────────────────────────────────────

/** `sysctl -n vm.loadavg` prints "{ 2.13 2.40 2.51 }"; os.loadavg() is what the gatherer uses, this reads the fixture. */
export function parseLoadAvg(text: string): number | null {
  const m = /\{\s*([\d.]+)/.exec(text) ?? /load averages?:\s*([\d.]+)/i.exec(text)
  const n = m ? Number.parseFloat(m[1]!) : Number.NaN
  return Number.isFinite(n) ? n : null
}
