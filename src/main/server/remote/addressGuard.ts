import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * Where an outbound webhook may never go (R2 M3): loopback, link-local
 * (the cloud metadata address lives there), RFC 1918, CGNAT, the v6
 * unique-local and link-local ranges, multicast and reserved space, plus
 * the hostnames that resolve to such places from inside a network. The
 * host is resolved before a target is accepted and again inside the
 * socket's own lookup when a delivery connects, so a name that changes
 * its answer later (DNS rebinding) is refused at connect time too.
 */

const v4 = (ip: string): number[] => ip.split('.').map(Number)

function privateV4(ip: string): boolean {
  const [a, b, c] = v4(ip)
  return (
    a === 0 || // this network
    a === 10 || // RFC 1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT, including 100.100.100.200
    (a === 169 && b === 254) || // link-local, including 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // protocol assignments (192.0.0.192), TEST-NET-1
    (a === 192 && b === 168) || // RFC 1918
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved, including the broadcast address
  )
}

/** The 16 bytes of a v6 literal, with an embedded v4 tail folded in; null when malformed. */
function v6Bytes(ip: string): Uint8Array | null {
  let text = ip.toLowerCase()
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (tail) {
    const [a, b, c, d] = v4(tail[2])
    text = `${tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - rest.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null
  const groups = [...head, ...Array<string>(missing).fill('0'), ...rest].map((g) => parseInt(g, 16))
  if (groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null
  const out = new Uint8Array(16)
  groups.forEach((g, i) => {
    out[2 * i] = g >> 8
    out[2 * i + 1] = g & 0xff
  })
  return out
}

function privateV6(ip: string): boolean {
  const b = v6Bytes(ip)
  if (!b) return true
  const zeroThrough = (n: number): boolean => b.subarray(0, n).every((x) => x === 0)
  if (zeroThrough(15) && b[15] <= 1) return true // :: and ::1
  if (zeroThrough(10) && b[10] === 0xff && b[11] === 0xff) return privateV4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`) // ::ffff:a.b.c.d
  if (zeroThrough(12)) return true // ::a.b.c.d, deprecated
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return true // 64:ff9b::/96 NAT64 can embed a private v4
  if ((b[0] & 0xfe) === 0xfc) return true // fc00::/7 unique local, including fd00:ec2::254
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true // fe80::/10 link-local
  if (b[0] === 0xff) return true // multicast
  return false
}

/** True for an address a webhook must not reach; anything that is not an address counts as private. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) return privateV4(ip)
  if (kind === 6) return privateV6(ip)
  return true
}

/** 127/8, ::1 and the mapped form: the one range a test receiver may sit in. */
export function isLoopbackAddress(ip: string): boolean {
  if (isIP(ip) === 4) return v4(ip)[0] === 127
  const b = isIP(ip) === 6 ? v6Bytes(ip) : null
  if (!b) return false
  const zeroThrough = (n: number): boolean => b.subarray(0, n).every((x) => x === 0)
  if (zeroThrough(15) && b[15] === 1) return true
  return zeroThrough(10) && b[10] === 0xff && b[11] === 0xff && b[12] === 127
}

/** Names that mean "inside this network" wherever they resolve: refused without a lookup. */
export function isForbiddenHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (!h.includes('.')) return true // localhost, metadata, instance-data: a bare label follows the search domain
  return ['.localhost', '.local', '.internal', '.arpa', '.svc', '.cluster.local'].some((s) => h.endsWith(s))
}

export interface GuardOptions {
  /** Let a receiver on 127.0.0.1 / ::1 through (a test harness); never any other private range. */
  allowLoopback?: boolean
  /** Test seam for the DNS lookup. */
  resolve?: (hostname: string) => Promise<LookupAddress[]>
}

export const REFUSED = 'webhook URL points at a private or local address'

/** The throws carry a code, so a delivery log line names the cause and never the URL. */
const refused = (message: string, code: 'EREFUSEDTARGET' | 'ENOTFOUND'): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code })

const allowed = (ip: string, options: GuardOptions): boolean =>
  options.allowLoopback && isLoopbackAddress(ip) ? true : !isPrivateAddress(ip)

/**
 * The addresses a hostname (or literal, bracketed or not) may be connected
 * to, or a throw naming the reason. Every answer must be allowed: one
 * private record among public ones is refused.
 */
export async function resolveGuarded(hostname: string, options: GuardOptions = {}): Promise<LookupAddress[]> {
  const host = hostname.replace(/^\[|\]$/g, '')
  const literal = isIP(host)
  if (literal) {
    if (!allowed(host, options)) throw refused(REFUSED, 'EREFUSEDTARGET')
    return [{ address: host, family: literal }]
  }
  if (isForbiddenHostname(host)) throw refused(REFUSED, 'EREFUSEDTARGET')
  const resolve = options.resolve ?? ((h: string) => lookup(h, { all: true, verbatim: true }))
  let addresses: LookupAddress[]
  try {
    addresses = await resolve(host)
  } catch {
    throw refused('webhook host does not resolve', 'ENOTFOUND')
  }
  if (addresses.length === 0) throw refused('webhook host does not resolve', 'ENOTFOUND')
  if (addresses.some((a) => !allowed(a.address, options))) throw refused(REFUSED, 'EREFUSEDTARGET')
  return addresses
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void

/**
 * A `lookup` for net/tls connect that answers only guarded addresses, so
 * the connection itself refuses a private answer — nothing between the
 * check and the connect can change what the socket reaches.
 */
export function guardedLookup(options: GuardOptions = {}) {
  return (hostname: string, lookupOptions: { all?: boolean; family?: number | string } | number, callback: LookupCallback): void => {
    const opts = typeof lookupOptions === 'object' ? lookupOptions : { family: lookupOptions }
    const family = opts.family === 4 || opts.family === 6 ? opts.family : opts.family === 'IPv4' ? 4 : opts.family === 'IPv6' ? 6 : 0
    resolveGuarded(hostname, options).then(
      (addresses) => {
        const matching = family ? addresses.filter((a) => a.family === family) : addresses
        if (matching.length === 0) return callback(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }))
        if (opts.all) callback(null, matching)
        else callback(null, matching[0].address, matching[0].family)
      },
      (err: NodeJS.ErrnoException) => callback(err)
    )
  }
}
