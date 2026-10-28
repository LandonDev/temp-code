import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const LIB = join(__dirname, 'lib', 'release-notes.sh')

function cap(input: string, budget: number, prev: string): string {
  return execFileSync('sh', ['-c', `. "$0"; cap_release_notes "$1" "$2"`, LIB, String(budget), prev], {
    input,
    encoding: 'utf8',
  }).replace(/\n$/, '')
}

// 600 commit lines of 400 bytes each, newest first: 240,600 bytes in all.
const lines = Array.from({ length: 600 }, (_, i) => `- commit ${String(i).padStart(3, '0')} `.padEnd(400, 'x'))
const input = lines.join('\n') + '\n'

describe('cap_release_notes', () => {
  it('keeps whole lines, newest first, within the budget and counts the rest', () => {
    const out = cap(input, 100_000, 'v1.0.303')
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(100_000)
    const got = out.split('\n')
    const tail = got.pop()!
    expect(got).toEqual(lines.slice(0, got.length))
    expect(got.length).toBe(249)
    expect(tail).toBe(`… and ${600 - got.length} more commits since v1.0.303`)
  })

  it('leaves notes under the budget as they are', () => {
    const few = lines.slice(0, 3).join('\n')
    expect(cap(few + '\n', 100_000, 'v1.0.303')).toBe(few)
  })

  it('names no tag when there is no previous release', () => {
    expect(cap(input, 1_000, '').split('\n').pop()).toBe('… and 598 more commits')
  })
})
