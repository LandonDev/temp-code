import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { citations, expandBraces, sectionOf } from './lib/docsCitations'

const REPO = resolve(__dirname, '..')

/** The CLAUDE.md sections the docs sweep wrote, whose citations must stay true. */
export const GUARDED_SECTIONS = ['Add-ons: one registry, every harness', 'Skills: one store, materialized per host', "Computer use: the Mac's apps from any thread"]

describe('the citation extractor', () => {
  const fixture = [
    'The host is src/main/server/addons/ (`addonHost.ts`), proof `bun run script:e2e-addons`.',
    'Run `bun run gate --tier publish` or bun run computer:test; `bun run scripts/x.ts` is a file.',
    'Pure parts in src/shared/{addons,skills}.ts, the wire in `src/shared/contract-addons.ts`,',
    'globs like scripts/e2e-*.ts and `<userData>/harness/` are skipped, and so is docs/<name>.md.',
    'See docs/box.md "Add-ons", docs/computer-protocol.md §17. A path ends a sentence: native/tc-computer/README.md.',
    'Not paths: ~/.claude/skills, the person`s skills/synced, aliax-core/src/adapters/addon.ts.'
  ].join('\n')

  it('finds script entries and bun run names, never a file run', () => {
    expect(citations(fixture).scripts).toEqual(['script:e2e-addons', 'gate', 'computer:test'])
  })

  it('finds paths under the repo roots, drops trailing punctuation, expands one brace and skips globs and placeholders', () => {
    expect(citations(fixture).paths).toEqual([
      'src/main/server/addons/',
      'scripts/x.ts',
      'src/shared/addons.ts',
      'src/shared/skills.ts',
      'src/shared/contract-addons.ts',
      'docs/box.md',
      'docs/computer-protocol.md',
      'native/tc-computer/README.md'
    ])
  })

  it('expands one level of braces', () => {
    expect(expandBraces('src/main/server/{headroom,accountScore}.ts')).toEqual(['src/main/server/headroom.ts', 'src/main/server/accountScore.ts'])
    expect(expandBraces('src/a.ts')).toEqual(['src/a.ts'])
  })

  it('cuts a section at the next heading, and answers null for a missing one', () => {
    const md = '# T\n## One\na\nb\n## Two\nc\n'
    expect(sectionOf(md, 'One')).toBe('a\nb')
    expect(sectionOf(md, 'Two')).toBe('c\n')
    expect(sectionOf(md, 'Three')).toBeNull()
  })
})

describe("CLAUDE.md's guarded sections cite what exists", () => {
  const claude = readFileSync(join(REPO, 'CLAUDE.md'), 'utf8')
  const scripts = new Set(Object.keys((JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts))

  for (const heading of GUARDED_SECTIONS) {
    it(heading, () => {
      const text = sectionOf(claude, heading)
      expect(text, `CLAUDE.md has no section "## ${heading}"`).not.toBeNull()
      const cited = citations(text!)
      const missing = [
        ...cited.scripts.filter((s) => !scripts.has(s)).map((s) => `script entry ${s}`),
        ...cited.paths.filter((p) => !existsSync(join(REPO, p))).map((p) => `path ${p}`)
      ]
      expect(missing, `"${heading}" cites what is missing:\n  ${missing.join('\n  ')}`).toEqual([])
      expect(cited.paths.length + cited.scripts.length).toBeGreaterThan(0)
    })
  }
})
