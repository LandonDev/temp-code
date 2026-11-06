import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The app's proof machinery (LayoutProbe, the row-init probe, the transcript
 * trace, the Live Activity gallery) is compiled only under `#if DEBUG`, so a
 * Release build sees none of it. A reference to one of those types outside a
 * DEBUG region compiles in Debug and breaks `-configuration Release`, which
 * the box cannot build. This reads every Swift file under ios/TempCode,
 * collects the top-level types declared inside `#if DEBUG`, and refuses a
 * reference to any of them outside one. scripts/ios-sim-proof.sh's Release
 * compile is the proof on the Mac; this is the same rule wherever vitest runs.
 */
const repo = resolve(import.meta.dirname, '..')
const appRoot = join(repo, 'ios/TempCode')

type SwiftLine = { file: string; n: number; code: string; debug: boolean }

/** Each line with its comments cut and whether a `#if DEBUG` branch holds it. */
function swiftLines(file: string, text: string): SwiftLine[] {
  const stack: boolean[] = []
  const out: SwiftLine[] = []
  text.split('\n').forEach((raw, i) => {
    const t = raw.trim()
    const opened = t.match(/^#if\s+(.*)/)
    if (opened) return void stack.push(/^DEBUG\b/.test(opened[1]))
    if (/^#else(if)?\b/.test(t)) return void (stack[stack.length - 1] = false)
    if (/^#endif\b/.test(t)) return void stack.pop()
    out.push({ file, n: i + 1, code: raw.replace(/\/\/.*$/, ''), debug: stack.includes(true) })
  })
  return out
}

const DECLARATION = /^(?:@\w+\s+)*(?:(?:private|fileprivate|final|public|internal)\s+)*(?:enum|struct|class|actor)\s+(\w+)/

/** References to a DEBUG-only top-level type from code a Release build compiles. */
function releaseLeaks(lines: SwiftLine[]): string[] {
  const debugOnly = new Set(lines.flatMap((l) => (l.debug ? (l.code.match(DECLARATION)?.slice(1, 2) ?? []) : [])))
  const leaks: string[] = []
  for (const l of lines) {
    if (l.debug) continue
    for (const name of debugOnly) if (new RegExp(`\\b${name}\\b`).test(l.code)) leaks.push(`${l.file}:${l.n} ${name}`)
  }
  return leaks
}

function swiftFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name.endsWith('.xcodeproj') ? [] : swiftFiles(path)
    return path.endsWith('.swift') ? [path] : []
  })
}

describe('DEBUG-only Swift in ios/TempCode', () => {
  it('is never referenced from code a Release build compiles', () => {
    const lines = swiftFiles(appRoot).flatMap((f) => swiftLines(relative(repo, f), readFileSync(f, 'utf8')))
    expect(lines.some((l) => l.debug && /enum LayoutProbe\b/.test(l.code))).toBe(true)
    expect(releaseLeaks(lines)).toEqual([])
  })

  it('finds a call outside the DEBUG branch, and none inside it or its #else', () => {
    const src = [
      '#if DEBUG',
      'enum Probe { static func note() {} }',
      '#endif',
      'func a() {',
      '    #if DEBUG',
      '    Probe.note()',
      '    #else',
      '    // Probe.note() is DEBUG only',
      '    #endif',
      '    Probe.note()',
      '}',
    ].join('\n')
    expect(releaseLeaks(swiftLines('x.swift', src))).toEqual(['x.swift:10 Probe'])
  })

  it('counts an #else under a non-DEBUG #if as Release code', () => {
    const src = ['#if DEBUG', 'struct Gallery {}', '#endif', '#if canImport(UIKit)', '#else', 'let g = Gallery()', '#endif'].join('\n')
    expect(releaseLeaks(swiftLines('y.swift', src))).toEqual(['y.swift:6 Gallery'])
  })
})

describe('scripts/ios-sim-proof.sh', () => {
  const script = readFileSync(join(repo, 'scripts/ios-sim-proof.sh'), 'utf8')

  it('compiles the Release configuration before the Debug build every set uses', () => {
    const release = script.indexOf('-configuration Release')
    const debug = script.indexOf('Debug-iphonesimulator/TempCode.app')
    expect(release).toBeGreaterThan(0)
    expect(release).toBeLessThan(debug)
  })
})
