/**
 * The renderer's chunk map, from out/bundle-map.json (written by the
 * `bundleMap` plugin in electron.vite.config.ts on every `electron-vite
 * build`). Prints the entry chunk and its static closure (what a launch
 * parses before the first paint), the biggest lazy chunks, and the top
 * contributors to the entry chunk by package and by source directory.
 *
 *   bun scripts/bundle-map.ts [--top N] [--json]
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type ChunkRow = {
  type: 'chunk'
  entry: boolean
  bytes: number
  imports: string[]
  dynamicImports: string[]
  modules: Record<string, number>
}
export type BundleMap = { chunks: Record<string, ChunkRow | { type: 'asset'; bytes: number }> }

export function loadBundleMap(path = resolve('out/bundle-map.json')): BundleMap {
  return JSON.parse(readFileSync(path, 'utf8')) as BundleMap
}

export function entryChunk(map: BundleMap): [string, ChunkRow] {
  const found = Object.entries(map.chunks).find(
    (e): e is [string, ChunkRow] => e[1].type === 'chunk' && e[1].entry && e[0].startsWith('assets/index-')
  )
  if (!found) throw new Error('no renderer entry chunk in the bundle map')
  return found
}

/** The entry plus everything it imports statically, transitively: the bytes
 *  the first paint waits on. */
export function staticClosure(map: BundleMap, from: string): string[] {
  const seen = new Set<string>()
  const walk = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const row = map.chunks[file]
    if (!row || row.type !== 'chunk') return
    for (const dep of row.imports) walk(dep)
  }
  walk(from)
  return [...seen]
}

/** "node_modules/<pkg>" (scoped packages keep their scope) or the first
 *  two directories of a source path. */
export function groupOf(id: string): string {
  const nm = id.lastIndexOf('node_modules/')
  if (nm >= 0) {
    const rest = id.slice(nm + 'node_modules/'.length)
    const parts = rest.split('/')
    return 'node_modules/' + (parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0])
  }
  const clean = id.replace(/^\0/, '').split('?')[0]
  const parts = clean.split('/')
  return parts.slice(0, Math.min(parts.length - 1, 4)).join('/') || clean
}

export function topGroups(modules: Record<string, number>, top: number): [string, number][] {
  const sums = new Map<string, number>()
  for (const [id, bytes] of Object.entries(modules)) sums.set(groupOf(id), (sums.get(groupOf(id)) ?? 0) + bytes)
  return [...sums.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
}

const kb = (n: number) => `${(n / 1024).toFixed(1).padStart(8)} kB`

if (import.meta.main) {
  const args = process.argv.slice(2)
  const top = Number(args[args.indexOf('--top') + 1]) || 25
  const map = loadBundleMap()
  const [entryFile, entry] = entryChunk(map)
  const closure = staticClosure(map, entryFile)
  const closureBytes = closure.reduce((n, f) => n + map.chunks[f].bytes, 0)
  if (args.includes('--json')) {
    console.log(JSON.stringify({ entry: entryFile, entryBytes: entry.bytes, closure, closureBytes }, null, 2))
    process.exit(0)
  }
  console.log(`entry ${entryFile}: ${kb(entry.bytes)} (${Object.keys(entry.modules).length} modules)`)
  console.log(`static closure: ${closure.length} chunk(s), ${kb(closureBytes)}`)
  for (const f of closure) if (f !== entryFile) console.log(`  + ${f} ${kb(map.chunks[f].bytes)}`)
  console.log(`\nlazy chunks (${entry.dynamicImports.length} dynamic imports from the entry):`)
  const lazy = Object.entries(map.chunks)
    .filter(([f, r]) => r.type === 'chunk' && !closure.includes(f))
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, top)
  for (const [f, r] of lazy) console.log(`  ${kb(r.bytes)}  ${f}`)
  console.log(`\ntop contributors to the entry chunk:`)
  for (const [g, n] of topGroups(entry.modules, top)) console.log(`  ${kb(n)}  ${g}`)
  console.log(`\ntop modules in the entry chunk:`)
  for (const [id, n] of Object.entries(entry.modules).sort((a, b) => b[1] - a[1]).slice(0, top))
    console.log(`  ${kb(n)}  ${id}`)
}
