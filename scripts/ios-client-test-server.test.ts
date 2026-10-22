import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Every thread the iOS test server seeds must have an id of its own: the
// registry refuses a taken id, and one collision keeps the server from
// booting (the live suite and the simulator proof fail with it). The seeds
// are top-level statements of a script, so the check reads the source: each
// creation call (`make('x'`, `makeTyped('x'`, `agent('x'`, `create({ id: 'x'`)
// by its literal, or by the `THREAD_X = 'x'` constant it names.
const source = readFileSync(resolve(import.meta.dirname, 'ios-client-test-server.ts'), 'utf8')

function seededIds(text: string): string[] {
  const constants = new Map<string, string>()
  for (const m of text.matchAll(/export const (THREAD_[A-Z0-9_]+) = '([^']+)'/g)) constants.set(m[1]!, m[2]!)
  const ids: string[] = []
  const creation = /\b(?:make|makeTyped|agent)\(\s*(?:'([^']+)'|(THREAD_[A-Z0-9_]+))|\bcreate\(\{\s*id:\s*(?:'([^']+)'|(THREAD_[A-Z0-9_]+))/g
  for (const m of text.matchAll(creation)) {
    const literal = m[1] ?? m[3]
    const constant = m[2] ?? m[4]
    if (literal) ids.push(literal)
    else if (constant) ids.push(constants.get(constant) ?? constant)
  }
  return ids
}

describe('the iOS test server seeds', () => {
  it('use every thread id once', () => {
    const ids = seededIds(source)
    expect(ids.length).toBeGreaterThan(40)
    const seen = new Map<string, number>()
    for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1)
    const twice = [...seen].filter(([, n]) => n > 1).map(([id]) => id)
    expect(twice).toEqual([])
  })
  it('seed the ids the fleet codes against', () => {
    const ids = new Set(seededIds(source))
    for (const id of ['ios-queued', 'ios-stopped', 'ios-master', 'ios-master-paused', 'ios-project-plan', 'ios-notes-five', 'ios-notes-two', 'ios-notices', 'ios-failures', 'ios-preamble', 'ios-resources', 'ios-pinned-account', 'ios-xhost'])
      expect(ids.has(id), id).toBe(true)
  })
  it('the regex reads a creation of each shape', () => {
    expect(seededIds("make('a', {})\nmakeTyped(THREAD_B, 'chat')\nexport const THREAD_B = 'b'\nagent('c', 'explorer')\nserver.registry.create({ id: 'd', x: 1 })\ncreate({ id: THREAD_B })")).toEqual(['a', 'b', 'c', 'd', 'b'])
  })
})
