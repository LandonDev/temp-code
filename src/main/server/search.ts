import { execFileBudgeted as execFileP } from './spawnBudget'
import { lstat, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { glob } from 'tinyglobby'
import type { ProjectSearchOptions, ProjectSearchResult } from '@shared/contract-m3a'

const MAX_MATCHES = 500
const MAX_FILE_BYTES = 512 * 1024
const tokens = (value?: string): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
const expandHome = (path: string): string =>
  path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path

function column(line: string, query: string, options: ProjectSearchOptions): number | null {
  const needle = options.caseSensitive ? query : query.toLowerCase()
  const haystack = options.caseSensitive ? line : line.toLowerCase()
  let start = 0
  while (start <= haystack.length) {
    const index = haystack.indexOf(needle, start)
    if (index < 0) return null
    const before = Array.from(line.slice(0, index)).at(-1) ?? ''
    const after = Array.from(line.slice(index + needle.length))[0] ?? ''
    if (!options.wholeWord || (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after))) {
      return Buffer.byteLength(line.slice(0, index), 'utf8') + 1
    }
    start = index + 1
  }
  return null
}

function parseGrep(
  output: Buffer,
  root: string,
  query: string,
  options: ProjectSearchOptions
): ProjectSearchResult {
  const result: ProjectSearchResult = { matches: [], truncated: false }
  let offset = 0
  while (offset < output.length) {
    const pathEnd = output.indexOf(0, offset)
    if (pathEnd < 0) break
    const relative = output.subarray(offset, pathEnd).toString('utf8').replace(/\\/g, '/')
    const numberEnd = output.indexOf(0, pathEnd + 1)
    if (numberEnd < 0) break
    const line = Number(output.subarray(pathEnd + 1, numberEnd).toString())
    const newline = output.indexOf(10, numberEnd + 1)
    const end = newline < 0 ? output.length : newline
    const preview = output.subarray(numberEnd + 1, end).toString('utf8')
    offset = end + 1
    if (!relative || !Number.isInteger(line) || line < 1) continue
    result.matches.push({
      path: join(root, relative),
      relative,
      line,
      column: options.regex ? 1 : (column(preview, query, options) ?? 1),
      preview
    })
    if (result.matches.length >= MAX_MATCHES) {
      result.truncated = true
      break
    }
  }
  return result
}

async function gitGrep(
  root: string,
  query: string,
  options: ProjectSearchOptions
): Promise<ProjectSearchResult | null> {
  // --untracked: new files count before their first `git add`.
  const args = ['-C', root, 'grep', '--untracked', '-z', '-n', '-I', '--no-color']
  if (!options.caseSensitive) args.push('-i')
  if (options.wholeWord) args.push('-w')
  args.push(
    options.regex ? '-E' : '-F',
    '-e',
    query,
    '--',
    ...tokens(options.include),
    ...tokens(options.exclude).map((s) => `:(exclude)${s}`)
  )
  try {
    const { stdout } = await execFileP('git', args, {
      encoding: 'buffer',
      timeout: 10_000,
      maxBuffer: 32 * 1024 * 1024
    })
    return parseGrep(stdout, root, query, options)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 1)
      return { matches: [], truncated: false }
    return null
  }
}

// Git's file index also covers untracked, non-ignored files. Outside a
// repository, make a bounded-by-file-size scan without opening watchers.
async function indexedFiles(root: string, options: ProjectSearchOptions): Promise<string[]> {
  try {
    const { stdout } = await execFileP(
      'git',
      [
        '-C',
        root,
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        ...tokens(options.include),
        ...tokens(options.exclude).map((s) => `:(exclude)${s}`)
      ],
      { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }
    )
    return [...new Set(stdout.split('\0').filter(Boolean))].sort()
  } catch {
    const patterns = tokens(options.include)
    return (
      await glob(patterns.length ? patterns : ['**/*'], {
        cwd: root,
        dot: true,
        onlyFiles: true,
        followSymbolicLinks: false,
        expandDirectories: true,
        ignore: ['**/.git/**', '**/node_modules/**', ...tokens(options.exclude)]
      })
    ).sort()
  }
}

async function scanFiles(
  root: string,
  query: string,
  options: ProjectSearchOptions
): Promise<ProjectSearchResult> {
  const result: ProjectSearchResult = { matches: [], truncated: false }
  // Invalid expressions reject rather than masquerading as no matches.
  const regex = options.regex
    ? new RegExp(
        options.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${query})(?![\\p{L}\\p{N}_])` : query,
        options.caseSensitive ? 'u' : 'iu'
      )
    : null
  for (const relative of await indexedFiles(root, options)) {
    const path = join(root, relative)
    let content: string
    try {
      const meta = await lstat(path)
      if (!meta.isFile() || meta.size > MAX_FILE_BYTES) continue
      const bytes = await readFile(path)
      if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) continue
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      continue
    }
    const lines = content.split(/\r?\n/)
    for (let index = 0; index < lines.length; index++) {
      const preview = lines[index]
      const found = regex ? (regex.test(preview) ? 1 : null) : column(preview, query, options)
      if (found === null) continue
      result.matches.push({ path, relative, line: index + 1, column: found, preview })
      if (result.matches.length >= MAX_MATCHES) return { ...result, truncated: true }
    }
  }
  return result
}

export async function searchProject(options: ProjectSearchOptions): Promise<ProjectSearchResult> {
  const query = options.query.trim()
  if (!query) return { matches: [], truncated: false }
  const root = resolve(expandHome(options.cwd))
  if (!(await stat(root)).isDirectory()) throw new Error(`${root}: Not a directory`)
  return (await gitGrep(root, query, options)) ?? (await scanFiles(root, query, options))
}
