import { Invalid } from './validation'

/**
 * Where a subscription's webhook may never go (R2 M3): loopback, link-local
 * (cloud metadata lives there), RFC 1918, CGNAT, the v6 unique-local and
 * link-local ranges, multicast and reserved space, and the hostnames that
 * mean "inside this network". A Worker has no raw DNS, so the host is
 * resolved over DNS-over-HTTPS when a subscription is made and again right
 * before each delivery; any private answer refuses the target.
 */

export const REFUSED = 'Webhook URL points at a private or local address'

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function privateV4(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

/** The 16 bytes of a v6 literal (an embedded v4 tail folded in), or null when it is not one. */
function v6Bytes(ip: string): Uint8Array | null {
  let text = ip.toLowerCase()
  if (!/^[0-9a-f:.]+$/.test(text) || !text.includes(':')) return null
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (tail) {
    if (!V4.test(tail[2])) return null
    const [a, b, c, d] = tail[2].split('.').map(Number)
    if ([a, b, c, d].some((n) => n > 255)) return null
    text = `${tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - rest.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null
  const groups = [...head, ...Array<string>(missing).fill('0'), ...rest]
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null
  const out = new Uint8Array(16)
  groups.forEach((g, i) => {
    const n = parseInt(g, 16)
    out[2 * i] = n >> 8
    out[2 * i + 1] = n & 0xff
  })
  return out
}

function privateV6(b: Uint8Array): boolean {
  const zeroThrough = (n: number): boolean => b.subarray(0, n).every((x) => x === 0)
  if (zeroThrough(15) && b[15] <= 1) return true
  if (zeroThrough(10) && b[10] === 0xff && b[11] === 0xff)
    return privateV4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`)
  if (zeroThrough(12)) return true
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return true
  if ((b[0] & 0xfe) === 0xfc) return true
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true
  if (b[0] === 0xff) return true
  return false
}

/** True for an address a webhook must not reach; anything that is not an address counts as private. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = V4.exec(ip)
  if (v4) return v4.slice(1).some((n) => Number(n) > 255) || privateV4(ip)
  const bytes = v6Bytes(ip)
  return bytes ? privateV6(bytes) : true
}

/** An address literal, bracketed or not, or null for a name. */
export function literalOf(hostname: string): string | null {
  const host = hostname.replace(/^\[|\]$/g, '')
  return V4.test(host) || v6Bytes(host) ? host : null
}

/** Names that mean "inside this network" wherever they resolve. */
export function isForbiddenHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (!h.includes('.')) return true
  return ['.localhost', '.local', '.internal', '.arpa', '.svc', '.cluster.local'].some((s) =>
    h.endsWith(s)
  )
}

export type Resolver = (hostname: string) => Promise<string[]>

/** DNS-over-HTTPS at Cloudflare: every A and AAAA answer for the name. */
export const dohResolve: Resolver = async (hostname) => {
  const answers = await Promise.all(
    ['A', 'AAAA'].map(async (type) => {
      const response = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
        { headers: { accept: 'application/dns-json' }, redirect: 'error' }
      )
      if (!response.ok) throw new Error('DNS query failed')
      const body = (await response.json()) as { Answer?: { type: number; data: string }[] }
      return (body.Answer ?? []).filter((a) => a.type === 1 || a.type === 28).map((a) => a.data)
    })
  )
  return answers.flat()
}

let resolver: Resolver = dohResolve
/** Test seam; null restores DNS-over-HTTPS. */
export function setResolver(fn: Resolver | null): void {
  resolver = fn ?? dohResolve
}

/** Throws `Invalid` unless the host is a public literal or a name that resolves only to public addresses. */
export async function guardTarget(hostname: string): Promise<void> {
  const literal = literalOf(hostname)
  if (literal) {
    if (isPrivateAddress(literal)) throw new Invalid(REFUSED)
    return
  }
  if (isForbiddenHostname(hostname)) throw new Invalid(REFUSED)
  let addresses: string[]
  try {
    addresses = await resolver(hostname)
  } catch {
    throw new Invalid('Webhook host does not resolve')
  }
  if (!addresses.length) throw new Invalid('Webhook host does not resolve')
  if (addresses.some(isPrivateAddress)) throw new Invalid(REFUSED)
}
