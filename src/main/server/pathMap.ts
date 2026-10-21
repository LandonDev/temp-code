import { isAbsolute, join, normalize } from 'node:path'

/**
 * Mac paths → box paths, shared by the history importer (historyImport.ts,
 * which the box runs straight from a checkout with node, so: node builtins
 * only and no repo imports here) and the harness config sync
 * (remote/harnessSync.ts), which rewrites the paths inside the text files
 * it lands. The shipped map is scripts/box/history-map.json.
 */

export interface HistoryMapping {
  /** Workspace roots that exist (or will) on the destination: source path → destination path. */
  roots: Record<string, string>
  /** Fallbacks for paths outside a mapped root (app worktrees, the home dir), longest match wins. */
  prefixes: Record<string, string>
}

export const stripSlash = (path: string): string => normalize(path).replace(/\/+$/, '') || '/'

export function parseMapping(raw: string): HistoryMapping {
  const parsed = JSON.parse(raw) as Partial<HistoryMapping>
  const clean = (table: unknown): Record<string, string> => {
    const out: Record<string, string> = {}
    if (table && typeof table === 'object') {
      for (const [from, to] of Object.entries(table as Record<string, unknown>)) {
        if (typeof to !== 'string' || !isAbsolute(from) || !isAbsolute(to)) throw new Error(`mapping: ${from} → ${String(to)} must be two absolute paths`)
        out[stripSlash(from)] = stripSlash(to)
      }
    }
    return out
  }
  return { roots: clean(parsed.roots), prefixes: clean(parsed.prefixes) }
}

export interface Remapper {
  /** True when the path is a mapped workspace root. */
  isRoot(path: string): boolean
  /** The path on the destination: by root, else by the longest prefix, else unchanged. */
  path(path: string): string
  /** Every mapped path inside a text rewritten the same way (roots first, then prefixes, longest first). */
  text(text: string): string
}

const byLength = (table: Record<string, string>): [string, string][] =>
  Object.entries(table)
    .map(([from, to]): [string, string] => [stripSlash(from), stripSlash(to)])
    .sort((a, b) => b[0].length - a[0].length)

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function remapper(mapping: HistoryMapping): Remapper {
  const roots = byLength(mapping.roots)
  const prefixes = byLength(mapping.prefixes)
  const under = (path: string, from: string): boolean =>
    path === from || path.startsWith(from === '/' ? '/' : from + '/')
  const apply = (path: string, table: [string, string][]): string | null => {
    for (const [from, to] of table) if (under(path, from)) return join(to, path.slice(from.length))
    return null
  }
  // In a text, a source path counts only on a path boundary on both sides:
  // `/Users/landonx` and `/opt/Users/landon` are left alone. The longest
  // source that matches wins (a root over a prefix of the same spelling).
  const ordered = [...roots, ...prefixes].filter(([from]) => from !== '/')
  const target = new Map<string, string>()
  for (const [from, to] of ordered) if (!target.has(from)) target.set(from, to)
  const sources = [...target.keys()].sort((a, b) => b.length - a.length)
  const re = sources.length > 0 ? new RegExp(`(?<![A-Za-z0-9_.-])(${sources.map(escapeRe).join('|')})(?![A-Za-z0-9_.-])`, 'g') : null
  return {
    isRoot: (path) => roots.some(([from]) => from === stripSlash(path)),
    path: (path) => {
      if (!isAbsolute(path)) return path
      const clean = stripSlash(path)
      return apply(clean, roots) ?? apply(clean, prefixes) ?? path
    },
    text: (text) => (re ? text.replace(re, (m) => target.get(m) ?? m) : text)
  }
}
