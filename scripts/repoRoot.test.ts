import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from './lib/repoRoot'

describe('repoRoot', () => {
  it('finds the checkout from scripts/, scripts/lib/ and a bundle in scripts/.out/', () => {
    const root = mkdtempSync(join(tmpdir(), 'tc-root-'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'temp-code' }))
    mkdirSync(join(root, 'scripts/.out'), { recursive: true })
    mkdirSync(join(root, 'scripts/lib'), { recursive: true })
    for (const from of ['scripts', 'scripts/lib', 'scripts/.out']) expect(repoRoot(join(root, from))).toBe(root)
  })

  it('passes over a package.json of another name, and throws with none above', () => {
    const root = mkdtempSync(join(tmpdir(), 'tc-root-'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'temp-code' }))
    mkdirSync(join(root, 'node_modules/x'), { recursive: true })
    writeFileSync(join(root, 'node_modules/x/package.json'), JSON.stringify({ name: 'x' }))
    expect(repoRoot(join(root, 'node_modules/x'))).toBe(root)
    expect(() => repoRoot(mkdtempSync(join(tmpdir(), 'tc-none-')))).toThrow(/no temp-code checkout above/)
  })

  it('from its own file, the checkout it lives in', () => {
    expect(repoRoot()).toBe(resolve(__dirname, '..'))
  })
})
