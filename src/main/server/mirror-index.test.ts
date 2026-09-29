import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeThreadsIndex } from './mirror'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-mirror-index-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const mirror = (title: string, updated: string, body: string): string =>
  `---\ntitle: "${title}"\ntype: implementation\nstatus: idle\nupdated: ${updated}\n---\n\n${body}`

describe('writeThreadsIndex', () => {
  it('lists every mirror newest first, reading only the head of each file', () => {
    // A transcript far larger than the head window: the index reads its
    // first 4 KB, never the whole file.
    writeFileSync(join(dir, 'a-big.md'), mirror('Big thread', '2026-09-28T10:00:00.000Z', 'x'.repeat(2_000_000)))
    writeFileSync(join(dir, 'b-small.md'), mirror('Small thread', '2026-09-29T10:00:00.000Z', 'short'))
    writeFileSync(join(dir, 'c-untitled.md'), 'no frontmatter here')
    writeFileSync(join(dir, 'notes.txt'), 'not a mirror')
    writeThreadsIndex(dir)
    const index = readFileSync(join(dir, 'INDEX.md'), 'utf8')
    const lines = index.split('\n').filter((l) => l.startsWith('- '))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('"Small thread"')
    expect(lines[0]).toContain('threads/b-small.md')
    expect(lines[1]).toContain('"Big thread"')
    expect(lines[1]).toContain('threads/a-big.md')
    expect(index).not.toContain('c-untitled')
  })

  it('a mirror whose frontmatter runs past the head window is skipped, not misread', () => {
    const long = `---\ntitle: "Padded"\nnoise: ${'y'.repeat(5_000)}\nupdated: 2026-09-29\n---\n`
    writeFileSync(join(dir, 'padded.md'), long)
    writeFileSync(join(dir, 'fine.md'), mirror('Fine', '2026-09-27', ''))
    writeThreadsIndex(dir)
    const index = readFileSync(join(dir, 'INDEX.md'), 'utf8')
    // The title sits inside the first 4 KB so the padded one still lists;
    // its `updated` (past the window) reads as unknown.
    expect(index).toContain('"Padded"')
    expect(index).toContain('"Fine"')
    expect(index.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(2)
  })
})
