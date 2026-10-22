/**
 * Dev servers a thread starts (docs/box.md "Dev servers on the box"). Pure
 * parsers for the two detectors in threadPorts.ts, in the ledger parser's
 * spirit: nothing is recorded that a command did not demonstrably open.
 *
 *  - announcedPorts: the server's own "Local: http://localhost:5173" line
 *    (Vite, Next, bun, express and the usual shapes), loopback or wildcard
 *    hosts only; the watcher records one only when a listener is there.
 *  - parseSs / parseLsof: the host's TCP listeners with their pids
 *    (`ss -ltnpH` on Linux, `lsof -nP -iTCP -sTCP:LISTEN` on macOS).
 *  - parsePs + descendants: the harness's process tree, from `ps -A -o pid=,ppid=`.
 */

export interface Announced {
  port: number
  /** The URL as the server printed it, else http://localhost:<port>. */
  url: string
}

export interface Listener {
  port: number
  pid: number
  /** The bound address as printed: 127.0.0.1, 0.0.0.0, *, [::1], [::]. */
  address: string
  /** The process name when the tool printed it. */
  command: string | null
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g

/** Hosts a dev server on this machine answers on: the forward dials loopback, which these all reach. */
const LOCAL_HOST = String.raw`(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\]|::1?)`
const URL_RE = new RegExp(String.raw`\bhttps?://${LOCAL_HOST}:(\d{2,5})(?:/[^\s'"<>)]*)?`, 'gi')
/** "listening on :8080", "on port 3000", "started server on 0.0.0.0:3000". */
const BARE_RE = new RegExp(String.raw`(?:\bport\s+|\bon\s+(?:${LOCAL_HOST})?:)(\d{2,5})\b`, 'gi')
/** A line that announces a server, not one that mentions a URL in passing. */
const ANNOUNCE_WORD = /\b(?:local|listening|listen|ready|running|started|serving|server|available)\b/i
/** Lines that name a port without opening it. */
const NOT_OPENED = /\b(?:in use|already|EADDRINUSE|error|failed|refused|trying another|retry|unable|cannot|could not|connect(?:ing|ed)? to|proxy(?:ing)? to)\b/i

export const validPort = (n: number): boolean => Number.isInteger(n) && n >= 1024 && n <= 65535

/** Every distinct port a server announced it is serving on, in order. */
export function announcedPorts(output: string): Announced[] {
  const out = new Map<number, Announced>()
  for (const rawLine of output.replace(ANSI, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.length > 400) continue
    if (!ANNOUNCE_WORD.test(line) || NOT_OPENED.test(line)) continue
    let found = false
    for (const m of line.matchAll(URL_RE)) {
      const port = Number(m[1])
      if (!validPort(port)) continue
      found = true
      if (!out.has(port)) out.set(port, { port, url: m[0].replace(/[.,;:]+$/, '').replace(/\/$/, '') })
    }
    if (found) continue
    for (const m of line.matchAll(BARE_RE)) {
      const port = Number(m[1])
      if (validPort(port) && !out.has(port)) out.set(port, { port, url: `http://localhost:${port}` })
    }
  }
  return [...out.values()]
}

/** The port at the end of an address column: 127.0.0.1:5173, *:3000, [::1]:8080, [::]:80. */
function portOf(addr: string): { address: string; port: number } | null {
  const i = addr.lastIndexOf(':')
  if (i < 0) return null
  const port = Number(addr.slice(i + 1))
  if (!Number.isInteger(port) || port <= 0) return null
  return { address: addr.slice(0, i), port }
}

/**
 * `ss -ltnpH` (Linux): `LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=1234,fd=20),...)`.
 * A socket shared by several processes yields a row for each pid.
 */
export function parseSs(text: string): Listener[] {
  const out: Listener[] = []
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5 || cols[0] !== 'LISTEN') continue
    const at = portOf(cols[3])
    if (!at) continue
    for (const m of line.matchAll(/\("([^"]*)",pid=(\d+)/g)) {
      out.push({ port: at.port, pid: Number(m[2]), address: at.address, command: m[1] || null })
    }
  }
  return out
}

/**
 * `lsof -nP -iTCP -sTCP:LISTEN` (macOS):
 * `node 1234 landon 20u IPv4 0x… 0t0 TCP 127.0.0.1:5173 (LISTEN)`; the header row is skipped.
 */
export function parseLsof(text: string): Listener[] {
  const out: Listener[] = []
  for (const line of text.split('\n')) {
    if (!/\(LISTEN\)\s*$/.test(line)) continue
    const cols = line.trim().split(/\s+/)
    const pid = Number(cols[1])
    const name = cols[cols.length - 2]
    const at = name ? portOf(name) : null
    if (!Number.isInteger(pid) || !at) continue
    out.push({ port: at.port, pid, address: at.address, command: cols[0].replace(/\\x20/g, ' ') || null })
  }
  return out
}

/** `ps -A -o pid=,ppid=` → pid → parent pid. */
export function parsePs(text: string): Map<number, number> {
  const parents = new Map<number, number>()
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (m) parents.set(Number(m[1]), Number(m[2]))
  }
  return parents
}

/** The roots and every process below them. */
export function descendants(parents: ReadonlyMap<number, number>, roots: Iterable<number>): Set<number> {
  const children = new Map<number, number[]>()
  for (const [pid, ppid] of parents) {
    const list = children.get(ppid)
    if (list) list.push(pid)
    else children.set(ppid, [pid])
  }
  const out = new Set<number>()
  const stack = [...roots]
  while (stack.length) {
    const pid = stack.pop() as number
    if (out.has(pid)) continue
    out.add(pid)
    for (const c of children.get(pid) ?? []) stack.push(c)
  }
  return out
}

/** One listener per port (the first pid: the parent of a shared socket comes first in ss and lsof). */
export function byPort(listeners: readonly Listener[]): Map<number, Listener> {
  const out = new Map<number, Listener>()
  for (const l of listeners) if (!out.has(l.port)) out.set(l.port, l)
  return out
}

/** The row's label: the announced URL, else the command (first line, trimmed), else the process name. */
export function portLabel(port: number, opts: { url?: string | null; command?: string | null; process?: string | null }): string {
  if (opts.url) return opts.url
  const cmd = opts.command?.split('\n')[0].trim()
  if (cmd) return cmd.length > 80 ? `${cmd.slice(0, 79)}…` : cmd
  return opts.process ? `${opts.process} :${port}` : `:${port}`
}
