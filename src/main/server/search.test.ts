import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { searchProject } from './search'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-search-'))
  execFileSync('git', ['-C', root, 'init', '-q'])
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/a.txt'), 'Alpha alphabet\nxx alpha\nregex 123\n')
  await writeFile(join(root, 'src/b.txt'), 'alpha\n')
  await writeFile(join(root, 'odd\nname.txt'), 'alpha\n')
  execFileSync('git', ['-C', root, 'add', '.'])
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
it('searches literal, case, whole-word, regex and include/exclude git pathspecs', async () => {
  const result = await searchProject({
    cwd: root,
    query: 'alpha',
    include: 'src/*.txt',
    exclude: 'src/b.txt'
  })
  expect(result).toEqual({
    matches: [
      {
        path: join(root, 'src/a.txt'),
        relative: 'src/a.txt',
        line: 1,
        column: 1,
        preview: 'Alpha alphabet'
      },
      {
        path: join(root, 'src/a.txt'),
        relative: 'src/a.txt',
        line: 2,
        column: 4,
        preview: 'xx alpha'
      }
    ],
    truncated: false
  })
  expect(
    (
      await searchProject({
        cwd: root,
        query: 'alpha',
        caseSensitive: true,
        wholeWord: true,
        include: 'src/a.txt'
      })
    ).matches
  ).toHaveLength(1)
  expect(
    (await searchProject({ cwd: root, query: 'regex [0-9]+', regex: true })).matches[0].line
  ).toBe(3)
  expect((await searchProject({ cwd: root, query: 'missing' })).matches).toEqual([])
  expect(
    (await searchProject({ cwd: root, query: 'alpha' })).matches.some(
      (m) => m.relative === 'odd\nname.txt'
    )
  ).toBe(true)
})
it('falls back when git grep fails, skips invalid/binary/large files and applies globs', async () => {
  await rm(join(root, '.git'), { recursive: true })
  await writeFile(join(root, 'src/binary.txt'), Buffer.from('alpha\0'))
  await writeFile(join(root, 'src/invalid.txt'), Buffer.from([0xff, ...Buffer.from('alpha')]))
  await writeFile(join(root, 'src/large.txt'), 'alpha\n'.repeat(100_000))
  const result = await searchProject({
    cwd: root,
    query: 'alpha',
    include: 'src/*.txt',
    exclude: '**/b.txt',
    caseSensitive: true,
    wholeWord: true
  })
  expect(result.matches).toHaveLength(1)
  expect(result.matches[0]).toMatchObject({ relative: 'src/a.txt', line: 2, column: 4 })
  expect(
    (await searchProject({ cwd: root, query: 'regex [0-9]+', regex: true })).matches
  ).toHaveLength(1)
  await expect(searchProject({ cwd: root, query: '[', regex: true })).rejects.toThrow()
})
it('caps git and fallback results at 500 rows', async () => {
  await writeFile(join(root, 'many.txt'), 'target\n'.repeat(501))
  execFileSync('git', ['-C', root, 'add', '.'])
  for (let i = 0; i < 2; i++) {
    const result = await searchProject({ cwd: root, query: 'target' })
    expect(result.matches).toHaveLength(500)
    expect(result.truncated).toBe(true)
    if (i === 0) await rm(join(root, '.git'), { recursive: true })
  }
})
