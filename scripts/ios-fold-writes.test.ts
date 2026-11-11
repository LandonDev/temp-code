import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/* The phone's transcript rebuilds only the rows whose items were written
 * (ios/TempCodeClient TranscriptModel over ThreadFold's FoldChanges). That
 * holds only while every write to the fold's items is recorded: a write
 * that went round the helpers would leave a stale row on screen, and no
 * test of the rows would see it until a thread happened to take that path.
 * So the fold's source is held to it: an item changes in `set`, a key in
 * `rekeyEcho`, the list grows in `append` and shrinks in `errorsCleared`,
 * and each of the four records the item it touched. */
const source = readFileSync(resolve(__dirname, '../ios/TempCodeClient/Sources/TempCodeClient/Rendering/ThreadFold.swift'), 'utf8')
const code = source.replace(/\/\/[^\n]*/g, '')

/** The body of `func name(` up to the next declaration at its indent. */
function body(name: string): string {
  const start = code.indexOf(`func ${name}(`)
  expect(start, name).toBeGreaterThan(0)
  const rest = code.slice(start)
  const end = rest.search(/\n    \}\n/)
  return rest.slice(0, end)
}

describe("ThreadFold's writes to its items", () => {
  it('assign an item in one place, the helper that records it', () => {
    const writes = [...code.matchAll(/items\[[^\]]+\]\.item\s*=[^=]/g)]
    expect(writes).toHaveLength(1)
    expect(body('set')).toMatch(/items\[index\]\.item = item\s+changes\.touch\(index\)/)
  })

  it('change a key, grow and shrink the list only where the change is recorded', () => {
    expect([...code.matchAll(/items\[[^\]]+\]\.key\s*=[^=]/g)]).toHaveLength(1)
    expect(body('rekeyEcho')).toMatch(/items\[index\]\.key = key\s+changes\.touch\(index\)/)
    expect([...code.matchAll(/items\.append\(/g)]).toHaveLength(1)
    expect(body('append')).toMatch(/items\.append\([\s\S]*changes\.touch\(items\.count - 1\)/)
    expect([...code.matchAll(/items\.(removeAll|remove|removeFirst|removeLast|removeSubrange|insert|swapAt|sort|reverse)\b\s*[({]/g)]).toHaveLength(1)
    expect(code).toMatch(/items\.removeAll \{ \$0\.item\.isError \}\s+changes\.touch\(first\)/)
  })

  it('never replace the list whole', () => {
    expect([...code.matchAll(/(^|[^.\w])items\s*=[^=]/gm)].filter((m) => !/var items/.test(code.slice(Math.max(0, m.index! - 30), m.index! + 10)))).toHaveLength(0)
  })
})
