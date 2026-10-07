import { BlockList, isIP } from 'node:net'
import { ASSET_SCHEME } from '@shared/assets'

/**
 * What the hidden HTML preview window may fetch. The page itself comes from
 * the asset scheme's in-memory preview map; beyond that only public web
 * hosts, so a page cannot read local files or reach this machine's network.
 * A public hostname that resolves to a private address (DNS rebinding) is not
 * caught: the page is the user's own agent's output on their own machine,
 * and the preview window holds none of the app's cookies or storage.
 */

export const PREVIEW_PAGE_PREFIX = `${ASSET_SCHEME}://page/preview/`

const LOCAL = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8], // unspecified
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved and broadcast
] as const) {
  LOCAL.addSubnet(net, prefix, 'ipv4')
}
for (const [net, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8] // multicast
] as const) {
  LOCAL.addSubnet(net, prefix, 'ipv6')
}
const MAPPED = new BlockList()
MAPPED.addSubnet('::ffff:0:0', 96, 'ipv6')
const NAT64 = new BlockList()
NAT64.addSubnet('64:ff9b::', 96, 'ipv6')
const SIX_TO_FOUR = new BlockList()
SIX_TO_FOUR.addSubnet('2002::', 16, 'ipv6')

/** The 16-bit groups of an IPv6 address, dotted-quad tails included. */
function ipv6Groups(address: string): number[] {
  const bare = address.split('%', 1)[0]!
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(bare)
  const text = dotted
    ? bare.slice(0, dotted.index) +
      ((Number(dotted[1]) << 8) | Number(dotted[2])).toString(16) +
      ':' +
      ((Number(dotted[3]) << 8) | Number(dotted[4])).toString(16)
    : bare
  const [head = '', tail] = text.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const fill = tail === undefined ? 0 : 8 - left.length - right.length
  return [...left, ...Array<string>(Math.max(0, fill)).fill('0'), ...right].map((g) =>
    parseInt(g || '0', 16)
  )
}

/** The IPv4 address an IPv6 mapped, NAT64 or 6to4 address carries, if any. */
function embeddedIPv4(address: string): string | undefined {
  const at = MAPPED.check(address, 'ipv6')
    ? 6
    : NAT64.check(address, 'ipv6')
      ? 6
      : SIX_TO_FOUR.check(address, 'ipv6')
        ? 1
        : -1
  if (at === -1) return undefined
  const groups = ipv6Groups(address)
  const high = groups[at] ?? 0
  const low = groups[at + 1] ?? 0
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

/** Whether an IP literal is loopback, private, link-local, multicast or unspecified. */
export function isLocalAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return LOCAL.check(address, 'ipv4')
  if (family !== 6) return true
  if (LOCAL.check(address, 'ipv6')) return true
  const inner = embeddedIPv4(address)
  return inner !== undefined && LOCAL.check(inner, 'ipv4')
}

/** Whether a URL host is a public name: dotted, not a local suffix, not a local literal. */
export function isPublicHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (!name) return false
  if (isIP(name)) return !isLocalAddress(name)
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local')) return false
  return name.includes('.')
}

/** Whether the preview window may load `url`. */
export function allowRequest(url: string): boolean {
  if (url.startsWith(PREVIEW_PAGE_PREFIX)) return true
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return true
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return isPublicHost(parsed.hostname)
}
