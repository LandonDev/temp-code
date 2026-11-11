import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * CLAUDE.md is an index: Claude Code loads it whole into every thread's
 * first request, and at 305 KB it was about 121k tokens of a 200k window,
 * so every Claude thread in this project compacted on every request
 * (docs/agents/prompt-overhead.md). A subject's long account lives in
 * docs/agents/<slug>.md; CLAUDE.md gets one entry for it.
 */
const ROOT = resolve(import.meta.dirname, '..')
const CLAUDE_MD = join(ROOT, 'CLAUDE.md')
const AGENTS = join(ROOT, 'docs', 'agents')
export const CLAUDE_MD_BUDGET = 40_000

const WHERE = 'Put the long account in docs/agents/<slug>.md (the section the subject belongs to, or a new file) and give CLAUDE.md one short entry that links it.'

const text = readFileSync(CLAUDE_MD, 'utf8')
const links = [...text.matchAll(/\]\((docs\/agents\/[^)#\s]+\.md)(?:#[^)]*)?\)/g)].map((m) => m[1])

describe('CLAUDE.md, the index', () => {
  it(`stays within ${CLAUDE_MD_BUDGET.toLocaleString('en-US')} bytes`, () => {
    const size = Buffer.byteLength(text)
    expect(size, `CLAUDE.md is ${size.toLocaleString('en-US')} bytes. ${WHERE}`).toBeLessThanOrEqual(CLAUDE_MD_BUDGET)
  })

  it('links only files that exist', () => {
    const missing = links.filter((l) => !existsSync(join(ROOT, l)))
    expect(missing, `CLAUDE.md links files that are not there. ${WHERE}`).toEqual([])
  })

  it('links every file in docs/agents exactly once', () => {
    const files = readdirSync(AGENTS)
      .filter((f) => f.endsWith('.md'))
      .map((f) => `docs/agents/${f}`)
    const counts = new Map<string, number>()
    for (const l of links) counts.set(l, (counts.get(l) ?? 0) + 1)
    const unlinked = files.filter((f) => !counts.has(f))
    const twice = [...counts.entries()].filter(([, n]) => n > 1).map(([f]) => f)
    expect({ unlinked, twice }, `Every docs/agents file has one entry in CLAUDE.md. ${WHERE}`).toEqual({ unlinked: [], twice: [] })
  })
})
