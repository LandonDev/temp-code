import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..')
const pkg = 'native/tc-computer'
const targets = [
  'ComputerProtocol',
  'ComputerCore',
  'AXReader',
  'AXText',
  'Input',
  'Capture',
  'ComputerServiceKit',
  'ComputerService',
  'tc-computer'
]
const required = ['ComputerProtocol', 'ComputerCore', 'ComputerServiceKit']
type Source = { path: string; text: string }

function swiftFiles(dir: string): Source[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return swiftFiles(path)
    return entry.isFile() && entry.name.endsWith('.swift')
      ? [{ path: relative(root, path), text: readFileSync(path, 'utf8') }]
      : []
  })
}

// Keep line numbers and quoted URLs intact when removing // comments.
function withoutLineComments(text: string): string {
  return text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) =>
    match.startsWith('//') ? ' '.repeat(match.length) : match
  )
}

const sources = targets.flatMap((target) => swiftFiles(join(root, pkg, 'Sources', target)))
const location = (source: Source, index: number) =>
  `${source.path}:${source.text.slice(0, index).split('\n').length}`

function violations(
  pattern: RegExp,
  allow?: (source: Source) => boolean,
  ignoreComments = false
): string[] {
  return sources.flatMap((source) => {
    if (allow?.(source)) return []
    const text = ignoreComments ? withoutLineComments(source.text) : source.text
    return [...text.matchAll(pattern)].map(
      (match) => `${location(source, match.index)}: ${match[0]}`
    )
  })
}

function yamlBlock(lines: string[], header: string, start = 0): { start: number; end: number } {
  const index = lines.findIndex((line, i) => i >= start && line === header)
  expect(
    index,
    `electron-builder.yml:${start + 1}: missing ${header.trim()}`
  ).toBeGreaterThanOrEqual(0)
  const indent = header.length - header.trimStart().length
  let end = index + 1
  while (end < lines.length) {
    const line = lines[end]
    if (
      line.trim() &&
      !line.trimStart().startsWith('#') &&
      line.length - line.trimStart().length <= indent
    )
      break
    end++
  }
  return { start: index, end }
}

describe('tc-computer product guards', () => {
  it('finds the required product source directories', () => {
    for (const target of required) {
      const path = `${pkg}/Sources/${target}`
      expect(
        existsSync(join(root, path)) && statSync(join(root, path)).isDirectory(),
        `${path}:1: required product target is missing`
      ).toBe(true)
    }
  })

  it('reserves stdout for the protocol writer in every product source, including Generated', () => {
    const found = violations(/\bprint\(|\bFileHandle\s*\.\s*standardOutput\b/g, undefined, true)
    expect(found, `stdout writes in product sources:\n${found.join('\n')}`).toEqual([])
  })

  it('resolves dynamic symbols only through ComputerCore/PrivateSymbol.swift', () => {
    const found = violations(
      /\bdlsym\s*\(/g,
      (source) => source.path === `${pkg}/Sources/ComputerCore/PrivateSymbol.swift`
    )
    expect(found, `direct symbol lookups:\n${found.join('\n')}`).toEqual([])
  })

  it('never declares a private symbol with @_silgen_name', () => {
    const found = violations(/@_silgen_name\b/g)
    expect(found, `static private-symbol declarations:\n${found.join('\n')}`).toEqual([])
  })

  it('never imports or links a private framework', () => {
    const imports = violations(
      /\bimport\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?(?:SkyLight\b[\w.]*|[\w.]*PrivateFrameworks[\w.]*)/g
    )
    const manifest: Source = {
      path: `${pkg}/Package.swift`,
      text: readFileSync(join(root, pkg, 'Package.swift'), 'utf8')
    }
    const text = withoutLineComments(manifest.text)
    const links: string[] = []
    for (const match of text.matchAll(/\blinkerSettings\s*:\s*\[/g)) {
      const start = match.index + match[0].length
      let end = start
      let depth = 1
      while (end < text.length && depth) {
        if (text[end] === '[') depth++
        if (text[end] === ']') depth--
        end++
      }
      for (const name of text.slice(start, end).matchAll(/SkyLight|PrivateFrameworks/g)) {
        links.push(`${location(manifest, start + name.index)}: ${name[0]} in linkerSettings`)
      }
    }
    const found = [...imports, ...links]
    expect(found, `private framework dependencies:\n${found.join('\n')}`).toEqual([])
  })

  const readme: Source = {
    path: `${pkg}/README.md`,
    text: readFileSync(join(root, pkg, 'README.md'), 'utf8')
  }
  const readmeLines = readme.text.split('\n')
  const section = readmeLines.findIndex((line) => line === '## Private symbols')
  const rows: { symbol: string; test: string | undefined; line: number }[] = []
  for (let i = section + 1; section >= 0 && i < readmeLines.length; i++) {
    if (/^#{1,6} /.test(readmeLines[i])) break
    const columns = readmeLines[i].split('|').map((cell) => cell.trim())
    const symbol = columns[1]?.match(/^`([^`]+)`$/)?.[1]
    if (symbol)
      rows.push({ symbol, test: columns[5]?.match(/^`([A-Za-z_][\w]*)`$/)?.[1], line: i + 1 })
  }

  it('documents every runtime symbol lookup in the Private symbols table', () => {
    expect(section, `${readme.path}:1: missing ## Private symbols`).toBeGreaterThanOrEqual(0)
    expect(
      rows.length,
      `${readme.path}:${section + 1}: missing private-symbol rows`
    ).toBeGreaterThan(0)
    const missing = sources.flatMap((source) =>
      [
        ...withoutLineComments(source.text).matchAll(
          /\bPrivateSymbol\s*\.\s*lookup\s*\(\s*"([^"\n]+)"/g
        )
      ]
        .filter((match) => !rows.some((row) => row.symbol === match[1]))
        .map(
          (match) => `${location(source, match.index)}: ${match[1]} has no row in ${readme.path}`
        )
    )
    expect(missing, `undocumented private symbols:\n${missing.join('\n')}`).toEqual([])
  })

  it('names an existing Swift fallback test for every private-symbol row the binary looks up', () => {
    const tests = swiftFiles(join(root, pkg, 'Tests'))
    // a row whose symbol no product target looks up yet (its module has not landed) documents only
    const lookedUp = new Set(
      sources.flatMap((source) =>
        [
          ...withoutLineComments(source.text).matchAll(
            /\bPrivateSymbol\s*\.\s*lookup\s*\(\s*"([^"\n]+)"/g
          )
        ].map((match) => match[1])
      )
    )
    const missing = rows
      .filter((row) => lookedUp.has(row.symbol))
      .filter(
        (row) =>
          !row.test ||
          !tests.some((source) =>
            new RegExp(`\\bfunc\\s+${row.test}\\s*(?:<[^>]*>)?\\s*\\(`).test(
              withoutLineComments(source.text)
            )
          )
      )
      .map(
        (row) =>
          `${readme.path}:${row.line}: ${row.symbol} requires func ${row.test ?? '(missing Test column)'} under ${pkg}/Tests/`
      )
    expect(missing, `missing private-symbol fallback tests:\n${missing.join('\n')}`).toEqual([])
  })

  it('lists the helper under mac.binaries', () => {
    const lines = readFileSync(join(root, 'electron-builder.yml'), 'utf8').split('\n')
    const mac = yamlBlock(lines, 'mac:')
    const binaries = yamlBlock(lines, '  binaries:', mac.start + 1)
    expect(
      binaries.end,
      `electron-builder.yml:${binaries.start + 1}: binaries must be under mac`
    ).toBeLessThanOrEqual(mac.end)
    expect(
      lines.slice(binaries.start + 1, binaries.end),
      `electron-builder.yml:${binaries.start + 1}: missing signed tc-computer binary`
    ).toContain('    - Contents/Resources/app/resources/native/tc-computer')
  })

  it('ignores all three native build outputs', () => {
    const lines = readFileSync(join(root, '.gitignore'), 'utf8').split('\n')
    for (const path of [
      'resources/native/tc-computer',
      'resources/native/tc-computer.stamp',
      'native/tc-computer/.build/'
    ]) {
      expect(lines, `.gitignore:1: missing ${path}`).toContain(path)
    }
  })
})
