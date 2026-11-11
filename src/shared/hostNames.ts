/**
 * What a host is called on screen. A machine's hostname carries the network's
 * domain ("Mac.attlocal.net", "studio.local", "box.lan"): the first label is
 * the machine, the rest is whichever router it sits behind. Every host
 * announces the short name (src/main/hostLabel.ts) and every client shortens
 * what an older host still says, so the desktop and the phone agree. The
 * phone's copy of the rule is HostNames in the client package
 * (ios/TempCodeClient/.../Environments/HostNames.swift); keep the two equal.
 */

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/** "Mac.attlocal.net" → "Mac"; an address, a name with no dot, or a name whose first label is empty stays whole. */
export function shortHostName(name: string): string {
  const text = name.trim()
  if (!text.includes('.') || IPV4.test(text) || text.includes(':')) return text
  const first = text.split('.')[0]
  return first ? first : text
}

/**
 * One label per host, by id: each name shortened, except where two hosts
 * would read the same (case-insensitive), which keep their names whole.
 * A name the person gave (`custom`) is never shortened.
 */
export function hostLabels(hosts: readonly { id: string; name: string; custom?: boolean }[]): Map<string, string> {
  const short = hosts.map((h) => ({ id: h.id, full: h.name.trim(), label: h.custom ? h.name.trim() : shortHostName(h.name) }))
  const counts = new Map<string, number>()
  for (const h of short) counts.set(h.label.toLowerCase(), (counts.get(h.label.toLowerCase()) ?? 0) + 1)
  return new Map(short.map((h) => [h.id, (counts.get(h.label.toLowerCase()) ?? 0) > 1 ? h.full : h.label]))
}
